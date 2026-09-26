# Práctica 07: Despliegue de Aplicaciones Node.js en Producción (AWS + Nginx + PM2)

Este repositorio contiene el CRUD de Gestión de Personal (Express + Mongoose + Angular) usado como
base para practicar el **despliegue en producción** de una aplicación Node.js, según la guía
[`docs/PDA06-Despliegue (1).pdf`](docs/PDA06-Despliegue%20%281%29.pdf) de la Maestría en Software.

## 🎯 Objetivos de la práctica

1. Configurar una infraestructura de red segura en **AWS EC2** para tráfico web (HTTP/HTTPS).
2. Configurar **Nginx** como proxy inverso y balanceador de carga frente al backend Node.js.
3. Gestionar procesos en segundo plano, clusters de procesamiento y variables de entorno seguras con **PM2**.
4. Automatizar el flujo de Integración y Despliegue Continuo (**CI/CD**) con `pm2 deploy` y GitHub.
5. Implementar monitorización y alertas de fallos en tiempo real mediante **Webhooks** (Discord).

---

## 📂 Estructura del repositorio

```
practica-07/
├── README.md
├── docker-compose.yaml          ← MongoDB + Mongo Express (entorno local)
├── docs/
│   └── PDA06-Despliegue (1).pdf ← enunciado de la práctica (guía del docente)
├── backend/
│   ├── src/                     ← Express + Mongoose + Zod (TypeScript, ESM)
│   ├── tests/                   ← Vitest
│   ├── postman/                 ← colección + entorno de Postman
│   └── Dockerfile
└── frontend/
    └── src/app/                 ← Angular (Smart/Dumb components + RxJS)
```

---

## 🏗️ Arquitectura de producción objetivo

```
Internet
   │  80/443 (HTTP/HTTPS)            🔒 SG: 22 solo "Mi IP", 3000 CERRADO
   ▼
┌─────────────────────── AWS EC2 (IP elástica) ───────────────────────┐
│                                                                      │
│   Nginx :80  ──── /            → frontend/dist/frontend/browser     │
│               └── /api/        → proxy_pass http://localhost:3000   │
│                                       │                              │
│                          PM2 (modo cluster, todos los vCPU)         │
│                          backend/dist/main.js  (Express + Mongoose) │
│                                       │                              │
└───────────────────────────────────────┼──────────────────────────────┘
                                          ▼
                              MongoDB (Atlas / servicio administrado
                              — NO en la misma instancia EC2)
```

`pm2-discord` observa la app y notifica caídas/errores a un canal de Discord vía webhook.
`pm2-logrotate` evita que los logs llenen el disco.

---

## 🔑 Referencia rápida

| Elemento | Valor |
|---|---|
| IP elástica | `TU_IP_ELASTICA_AQUÍ` |
| Ruta de despliegue en EC2 | `/var/www/pda-practica-07` |
| Repositorio (deploy) | `git@github.com:jmurillov1/pda-practica-07.git` (rama `main`) |
| Nombre de app en PM2 | `pda-api` |
| Puerto interno del backend | `3000` (cerrado al exterior, solo accesible vía Nginx) |
| Puertos públicos | `80` (HTTP), `443` (HTTPS, pendiente Certbot), `22` (SSH, restringido a "Mi IP") |
| Logs de la app | `/var/www/pda-practica-07/current/logs/{out,err}.log` |
| Endpoint de salud | `GET /api/v1/health` → `{ "data": { "status": "ok", "database": "connected" } }` |
| Config Nginx | `/etc/nginx/sites-available/default` |
| Ecosistema PM2 | `ecosystem.config.cjs` (raíz del repo, en el equipo local) |

---

## 🚀 Fases del despliegue

### Fase 1: Red y firewall (AWS)

1. **Grupo de seguridad** de la instancia EC2 → *Editar reglas de entrada*:
   - HTTP · puerto `80` · origen `0.0.0.0/0`
   - HTTPS · puerto `443` · origen `0.0.0.0/0`
   - SSH · puerto `22` · origen **Mi IP** (nunca `Anywhere`)
   - El puerto `3000` de Node.js **no** se abre públicamente.
2. **IP elástica**: EC2 → *Red y seguridad* → *IP elásticas* → *Asignar* → *Asociar* a la instancia.

### Fase 2: Servidor web y proxy inverso (Nginx)

Conectado por SSH a la instancia (`ssh -i "tu-llave.pem" ubuntu@TU_IP_ELASTICA`):

```bash
# Node.js LTS + npm
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable   # habilita pnpm

# Git y herramientas de compilación (bcrypt, mongoose, etc. compilan C/C++)
sudo apt install -y git build-essential

# Nginx
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx
sudo ufw allow 'Nginx Full'
sudo systemctl status nginx
```

Reemplaza `/etc/nginx/sites-available/default` para servir el build de Angular y reenviar `/api/` al backend:

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root /var/www/pda-practica-07/current/frontend/dist/frontend/browser;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Comandos útiles: `sudo systemctl {start|stop|reload} nginx`.

### Fase 3: Clonar el proyecto desde GitHub a EC2

```bash
# 1. Deploy key SSH en la instancia
ssh-keygen -t ed25519 -C "servidor-produccion"
cat ~/.ssh/id_ed25519.pub
# → GitHub: repo → Settings → Deploy keys → Add deploy key (sin permiso de escritura)
ssh -T git@github.com

# 2. Carpeta de despliegue
sudo mkdir -p /var/www/pda-practica-07
sudo chown -R ubuntu:ubuntu /var/www/pda-practica-07
```

> El clonado real lo hace `pm2 deploy` en la Fase 5; este paso solo prepara la llave y el directorio.

### Fase 4: PM2 — proceso, cluster y variables de entorno

En la instancia EC2, instalar PM2 global:

```bash
sudo npm install pm2 -g
```

En el **equipo local**, dentro de la raíz del repositorio, crear `ecosystem.config.cjs`
(extensión `.cjs` porque el backend usa ESM nativo — un `.js` fallaría al cargarse con `require`):

```js
module.exports = {
  apps: [
    {
      name: 'pda-api',
      cwd: './backend',
      script: 'dist/main.js',
      instances: 'max', // Modo Cluster: usa todos los núcleos de la CPU
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        CORS_ORIGIN: 'http://TU_IP_ELASTICA_AQUÍ',
        // MONGO_URI NO va aquí: se carga desde backend/.env (ver post-deploy)
      },
      error_file: '/var/www/pda-practica-07/logs/err.log',
      out_file: '/var/www/pda-practica-07/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],

  deploy: {
    production: {
      user: 'ubuntu',
      host: 'TU_IP_ELASTICA_AQUÍ',
      ref: 'origin/main',
      repo: 'git@github.com:jmurillov1/pda-practica-07.git',
      path: '/var/www/pda-practica-07',
      'post-deploy':
        'ln -sf /var/www/pda-practica-07/shared/.env backend/.env && ' +
        'pnpm install --frozen-lockfile --dir backend && pnpm --dir backend build && ' +
        'pnpm install --frozen-lockfile --dir frontend && pnpm --dir frontend build && ' +
        'mkdir -p /var/www/pda-practica-07/logs && ' +
        'pm2 reload ecosystem.config.cjs --env production && pm2 save',
      ssh_options: 'IdentityFile=~/.ssh/tu-llave-aws.pem',
    },
  },
};
```

Notas:
- `MONGO_URI` (secreto) vive solo en `/var/www/pda-practica-07/shared/.env` en el servidor —
  **nunca** en `ecosystem.config.cjs` ni en el repositorio. Créalo una vez en EC2 con el mismo
  formato de `backend/.env.example`, apuntando idealmente a un clúster **MongoDB Atlas** (recomendación
  de la guía: no alojar la base de datos en la misma EC2 que la aplicación).
- Si la instancia es `t2.micro`/`t3.micro`, considera añadir swap antes de compilar Angular
  (`ng build` puede agotar la RAM disponible).
- `ecosystem.config.cjs` sí se versiona (no contiene secretos); añádelo a `.gitignore` solo si en tu
  caso decides incluir credenciales dentro de él.

### Fase 5: Despliegue inicial y CI/CD

Desde el equipo local:

```bash
pm2 deploy production setup   # prepara la estructura en /var/www/pda-practica-07
pm2 deploy production         # clona, instala, compila y levanta el proceso
```

En la instancia EC2, para que PM2 resucite los procesos tras un reinicio del sistema operativo:

```bash
pm2 startup
pm2 save
```

Para cada despliegue posterior, basta con `git push origin main` y `pm2 deploy production` desde el
equipo local; no se vuelve a tocar la consola de AWS.

### Fase 6: Monitorización, logs y alertas (Discord)

```bash
# Webhook de Discord: servidor → Configuración → Integraciones → Webhooks → Nuevo webhook → copiar URL

# pm2-notify solo soporta SMTP; para Discord se usa el módulo dedicado pm2-discord
pm2 install pm2-discord
pm2 set pm2-discord:discord_url "URL_DE_TU_WEBHOOK_AQUÍ"
pm2 set pm2-discord:events "exit,error"   # solo caídas/errores

pm2 install pm2-logrotate   # rotación de logs, evita disco lleno

pm2 save --force
pm2 logs pm2-discord   # ver actividad del módulo de alertas
pm2 list                # listar procesos
pm2 stop pda-api        # detener
pm2 start pda-api       # iniciar
```

---

## ✅ Pruebas de verificación

1. **Prueba de red**: abrir `http://TU_IP_ELASTICA` en el navegador → debe verse la interfaz Angular,
   sin necesidad de especificar `:3000`.
2. **Prueba de resiliencia**: `pm2 stop pda-api` en EC2 → debe llegar una alerta al canal de Discord.
   Restaurar con `pm2 start pda-api`.
3. **Prueba de CI/CD**: hacer un cambio visual en local, `git push origin main`, ejecutar
   `pm2 deploy production` desde el equipo local, y refrescar el navegador sin haber tocado la consola
   de AWS.

---

## 🖥️ Desarrollo local

### Backend

```bash
cd backend
cp .env.example .env
pnpm install
pnpm dev       # tsx watch, puerto 3000
```

Otros scripts: `pnpm build`, `pnpm start`, `pnpm typecheck`, `pnpm lint` / `pnpm lint:fix`,
`pnpm format`, `pnpm test`.

### Frontend

```bash
cd frontend
pnpm install
pnpm start     # http://localhost:4200
```

En local, `frontend/src/environments/environment.development.ts` apunta a
`http://localhost:3000/api/v1`. Para producción, `environment.ts` debería usar una ruta relativa
(`apiUrl: '/api/v1'`), ya que en el servidor es Nginx quien resuelve `/api/` hacia el backend.

### Base de datos local

```bash
cp .env.example .env
docker compose up -d mongodb mongo-express
```

Mongo Express queda disponible en `http://localhost:8081`.

---

## 🔒 Nota de seguridad

- `.env`, `backend/.env`, la llave `.pem` de AWS y la URL del webhook de Discord **nunca** se versionan
  (excluidos vía `.gitignore`). Solo se comparten los `.env.example` con valores de ejemplo (`change_me`).
- El secreto `MONGO_URI` de producción vive únicamente en el servidor (`shared/.env`), fuera del
  repositorio y fuera de `ecosystem.config.cjs`.
- El puerto `3000` permanece cerrado al tráfico externo; todo el acceso público pasa por Nginx (80/443).

---

## 📝 Conclusiones de la guía

- **Separación de roles**: Nginx absorbe el tráfico público y libera a Node.js de la gestión de
  conexiones TCP/cabeceras, dejándolo enfocado en la lógica de negocio.
- **Alta disponibilidad**: el modo cluster de PM2 (`instances: "max"`) multiplica el rendimiento usando
  todos los vCPU disponibles y da autorecuperación ante excepciones no controladas.
- **Reducción de superficie de ataque**: solo 80/443 (web) y 22 (SSH, restringido) quedan expuestos;
  el puerto 3000 permanece aislado del tráfico externo.
- **CI/CD**: `pm2 deploy` elimina los `git pull`/reinicios manuales por SSH, permitiendo actualizar
  producción con un solo comando desde el equipo local.
- **Monitoreo proactivo**: los webhooks de Discord y la rotación de logs (`pm2-logrotate`) convierten
  la gestión de infraestructura en un modelo reactivo-a-proactivo, evitando además el llenado de disco.

## 📌 Recomendaciones para un entorno real

- **HTTPS obligatorio**: adquirir un dominio y emitir un certificado SSL/TLS gratuito con
  **Certbot (Let's Encrypt)** en vez de servir sobre IP + HTTP.
- **Base de datos externalizada**: usar un servicio administrado (p. ej. **MongoDB Atlas** o AWS RDS)
  en vez de instalar la base de datos en la misma instancia EC2 que la aplicación.
