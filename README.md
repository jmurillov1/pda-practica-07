# Práctica 07: Despliegue de Aplicaciones Node.js en Producción (AWS + Nginx + PM2 + Azure + Cloudflare)

Este repositorio contiene el CRUD de Gestión de Personal (Express + Mongoose + Angular) usado como
base para practicar el **despliegue en producción** de una aplicación Node.js, según la guía
[`docs/PDA06-Despliegue (1).pdf`](docs/PDA06-Despliegue%20%281%29.pdf) de la Maestría en Software.
Sobre esa base se extendió el despliegue a un esquema **multi-nube**: el backend (API) sigue en AWS EC2
con Nginx + PM2 como pide la guía, y el frontend (Angular) se separó a **Azure Static Web Apps**, con
**Cloudflare** administrando el dominio propio y el HTTPS de ambos.

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

## 🏗️ Arquitectura de producción

El frontend y el backend viven en **nubes distintas** (Azure y AWS), unidos por DNS/HTTPS de Cloudflare:

```
                              Navegador
                                  │
                    ┌─────────── Cloudflare (DNS + HTTPS) ───────────┐
                    │                                                 │
      app.TU_DOMINIO (CNAME, Proxied)                 api.TU_DOMINIO (A, Proxied + SSL Full)
                    │                                                 │
                    ▼                                                 ▼
     Azure Static Web Apps                          AWS EC2 (IP elástica) — SG: 22 "Mi IP", 3000 CERRADO
     (build Angular servido por CDN)                 Nginx :443 (cert. origen Cloudflare) → :3000
                                                                      │
                                                        PM2 (modo cluster, todos los vCPU)
                                                        backend/dist/main.js (Express + Mongoose)
                                                                      │
                                                                      ▼
                                                  MongoDB Atlas (servicio administrado,
                                                  NO en la misma instancia EC2)
```

`pm2-discord` observa la app y notifica caídas/errores a un canal de Discord vía webhook.
`pm2-logrotate` evita que los logs llenen el disco. El frontend (Azure) y el backend (EC2) se despliegan
con pipelines de CI/CD independientes (GitHub Actions y `pm2 deploy`, respectivamente).

---

## 🔑 Referencia rápida

| Elemento | Valor |
|---|---|
| Dominio del frontend | `https://app.TU_DOMINIO` (Cloudflare → Azure Static Web Apps) |
| Dominio de la API | `https://api.TU_DOMINIO` (Cloudflare Proxied → IP elástica EC2) |
| IP elástica (origen de la API) | `TU_IP_ELASTICA_AQUÍ` |
| Ruta de despliegue en EC2 | `/var/www/empleados-backend` |
| Repositorio (deploy) | `git@github.com:jmurillov1/pda-practica-07.git` (rama `main`) |
| Nombre de app en PM2 | `empleados-backend` |
| Puerto interno del backend | `3000` (cerrado al exterior, solo accesible vía Nginx) |
| Puertos públicos EC2 | `443` (HTTPS, hacia Cloudflare — modo Full), `80` (redirección), `22` (SSH, restringido a "Mi IP") |
| Certificado de origen | Emitido por Cloudflare (Origin CA), instalado en Nginx, válido solo para tráfico Cloudflare↔EC2 |
| Logs de la app | `/var/www/empleados-backend/logs/{out,err}.log` |
| Endpoint de salud | `GET /api/v1/health` → `{ "data": { "status": "ok", "database": "connected" } }` |
| Config Nginx | `/etc/nginx/sites-available/default` |
| Ecosistema PM2 | `backend/ecosystem.config.cjs` (dentro del repo, se ejecuta `pm2 deploy` desde `backend/`) |
| `.env` de producción | `/var/www/empleados-backend/source/backend/.env` (creado a mano en el servidor, con `MONGO_URI` de Atlas) |
| Frontend en Azure | Static Web Apps, plan Free, deploy vía GitHub Actions |
| Workflow del frontend | `.github/workflows/azure-static-web-apps-*.yml` |

---

## 🚀 Fases del despliegue

### Fase 1: Red y firewall (AWS)

1. **Grupo de seguridad** de la instancia EC2 → *Editar reglas de entrada*:
   - HTTPS · puerto `443` · origen `0.0.0.0/0` (Cloudflare habla con Nginx por HTTPS en modo **Full** —
     ver Fase 8; requiere el certificado de origen de Cloudflare instalado en Nginx)
   - HTTP · puerto `80` · origen `0.0.0.0/0` (Nginx lo deja solo para redirigir a `443`)
   - SSH · puerto `22` · origen **Mi IP** (nunca `Anywhere`)
   - El puerto `3000` de Node.js **no** se abre públicamente.
2. **IP elástica**: EC2 → *Red y seguridad* → *IP elásticas* → *Asignar* → *Asociar* a la instancia.

### Fase 2: Servidor web y proxy inverso (Nginx)

Conectado por SSH a la instancia (`ssh -i "tu-llave.pem" ubuntu@TU_IP_ELASTICA`):

```bash
# Node.js LTS + npm
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm (el backend lo usa: ver "packageManager" en backend/package.json)
sudo npm install -g pnpm@10.33.0
pnpm --version   # confirmar que responde 10.33.0

# Git y herramientas de compilación (bcrypt, mongoose, etc. compilan C/C++)
sudo apt install -y git build-essential

# Nginx
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx
sudo ufw allow 'Nginx Full'
sudo systemctl status nginx
```

> ⚠️ **`sudo corepack enable` falla en Ubuntu con `EACCES` al crear el symlink en `/usr/bin/pnpm`**
> (el usuario `ubuntu` no tiene permisos ahí, y a veces el propio corepack deja el binario apuntando
> a un caché roto en `~/.cache/node/corepack`). Por eso este README instala `pnpm` directamente con
> `npm install -g` en vez de usar corepack. Si ya intentaste `corepack enable` y `pnpm --version`
> falla con `Cannot find module '.../corepack/pnpm/.../pnpm.cjs'`, limpia el intento fallido antes:
> ```bash
> sudo rm -f /usr/bin/pnpm /usr/local/bin/pnpm
> rm -rf ~/.cache/node/corepack
> sudo npm install -g pnpm@10.33.0
> hash -r
> pnpm --version
> ```

Reemplaza `/etc/nginx/sites-available/default`. El frontend **ya no se sirve desde aquí** (vive en Azure
Static Web Apps, Fase 7): este Nginx solo hace de proxy inverso hacia la API para el dominio
`api.TU_DOMINIO`, y termina HTTPS con el **certificado de origen de Cloudflare** (Fase 8, modo **Full**):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name api.TU_DOMINIO;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name api.TU_DOMINIO;

    ssl_certificate     /etc/ssl/cloudflare/api.TU_DOMINIO.pem;      # Origin Certificate (Fase 8)
    ssl_certificate_key /etc/ssl/cloudflare/api.TU_DOMINIO.key;

    location / {
        proxy_pass http://localhost:3000;
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

En el **equipo local**, el archivo real usado es [`backend/ecosystem.config.cjs`](backend/ecosystem.config.cjs)
(vive dentro de `backend/`, no en la raíz, y por eso `pm2 deploy` se ejecuta desde ahí — ver Fase 5).
Extensión `.cjs` porque el backend usa ESM nativo — un `.js` fallaría al cargarse con `require`:

```js
module.exports = {
  apps: [{
    name: "empleados-backend",
    cwd: "./backend",
    script: "dist/main.js",
    instances: "max",
    exec_mode: "cluster",
    env: {
      NODE_ENV: "production",
      PORT: 3000,
      // Lista separada por comas: backend/src/app.ts la parte con .split(',')
      CORS_ORIGIN: "https://app.TU_DOMINIO,http://localhost:4200"
      // MONGO_URI NO va aquí: se carga desde backend/.env, creado a mano en el servidor
    },
    error_file: "/var/www/empleados-backend/logs/err.log",
    out_file: "/var/www/empleados-backend/logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    merge_logs: true
  }],
  deploy: {
    production: {
      user: 'ubuntu',
      host: 'TU_IP_ELASTICA_AQUÍ',
      ref: 'origin/main',
      repo: 'git@github.com:jmurillov1/pda-practica-07.git',
      path: '/var/www/empleados-backend',
      // ojo: el post-deploy corre desde la raíz del repo clonado (.../source), por eso
      // hay que entrar a "backend" para instalar/compilar y referenciar la ruta completa al reload
      'post-deploy':
        'cd backend && pnpm install --frozen-lockfile && pnpm build && cd .. && ' +
        'mkdir -p logs && pm2 reload backend/ecosystem.config.cjs --env production && pm2 save',
      ssh_options: "IdentityFile=~/.ssh/svr-01.pem",
    }
  }
};
```

Notas (aprendidas en el propio despliegue):
- Este repo es un **monorepo** (`backend/` y `frontend/` como subcarpetas, sin `package.json` en la
  raíz). La plantilla genérica de la guía asume `npm install`/`script: "./index.js"` en la raíz del
  repo — con este proyecto eso falla con `ENOENT ... source/package.json`. Por eso el `post-deploy`
  entra explícitamente a `backend/` y el `script` apunta a `dist/main.js` (el build compilado).
- `corepack enable` **no** se usa en el `post-deploy` (falla con `EACCES` al no tener permisos de
  `sudo` el usuario `ubuntu`). En su lugar, `pnpm` se instala una sola vez de forma global en el
  servidor con `sudo npm install -g pnpm@10.33.0` (ver Fase 2).
- `MONGO_URI` (secreto) vive solo en `/var/www/empleados-backend/source/backend/.env` en el
  servidor — **nunca** en `ecosystem.config.cjs` ni en el repositorio. Se crea una sola vez a mano
  (`nano backend/.env` dentro de esa ruta, con el mismo formato de `backend/.env.example`) apuntando
  a un clúster **MongoDB Atlas** (recomendación de la guía: no alojar la base de datos en la misma
  EC2 que la aplicación). Como `pm2 deploy` solo hace `git reset` sobre esa carpeta y `.env` está en
  `.gitignore`, el archivo persiste entre despliegues.
- En Atlas, agrega la IP elástica (`TU_IP_ELASTICA_AQUÍ`) en **Network Access** para que el backend pueda
  conectarse.
- Si la instancia es `t2.micro`/`t3.micro`, considera añadir swap antes de compilar Angular
  (`ng build` puede agotar la RAM disponible).
- `ecosystem.config.cjs` sí se versiona (no contiene secretos).
- **CORS multi-origen**: como el frontend (Azure) y la API (EC2) quedan en dominios distintos,
  `backend/src/app.ts` separa `CORS_ORIGIN` por comas (`env.CORS_ORIGIN.split(',')`) para poder aceptar
  a la vez el dominio de producción y `http://localhost:4200` en desarrollo.

### Fase 5: Despliegue inicial y CI/CD

Desde el equipo local, **dentro de `backend/`** (donde vive `ecosystem.config.cjs`):

```bash
cd backend
pm2 deploy production setup   # prepara la estructura en /var/www/empleados-backend
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
# Webhook de Discord: canal → Editar canal → Integraciones → Webhooks → Nuevo webhook → copiar URL

# pm2-notify solo soporta SMTP; para Discord se usa el módulo dedicado pm2-discord
pm2 install pm2-discord
pm2 set pm2-discord:discord_url "https://discord.com/api/webhooks/TU_ID/TU_TOKEN"

# ⚠️ pm2-discord NO tiene una clave "events" combinada: cada evento es un booleano propio.
# Por defecto ya vienen activos: kill=true, exception=true, stop=true (log/error/exit/restart=false).
pm2 set pm2-discord:error true
pm2 set pm2-discord:exit true

pm2 install pm2-logrotate   # rotación de logs, evita disco lleno

pm2 save --force
pm2 list                # confirma que "pm2-discord" aparece como módulo activo
pm2 logs pm2-discord    # ver actividad del módulo de alertas
pm2 stop empleados-backend    # detener (dispara el evento "stop" → notificación)
pm2 start empleados-backend   # iniciar
```

**Diagnóstico si no llega ninguna alerta:**
```bash
pm2 describe pm2-discord              # revisa que discord_url quedó bien guardada
curl -H "Content-Type: application/json" -d '{"content":"prueba manual"}' \
  "https://discord.com/api/webhooks/TU_ID/TU_TOKEN"   # prueba el webhook fuera de PM2
PM2_DISCORD_DEBUG=1 pm2 install pm2-discord && pm2 logs pm2-discord   # logs verbosos
```

### Fase 7: Frontend en Azure Static Web Apps

1. Azure Portal → **Static Web Apps** → **Crear** → plan **Free** → origen del código **GitHub** →
   seleccionar el repo y la rama `main`.
2. Azure genera solo el recurso y un `.yml` de arranque en
   `.github/workflows/azure-static-web-apps-<nombre-random>.yml` — **hay que corregirlo**: por defecto
   Azure compila con **Oryx**, que detecta `package.json` pero no `pnpm-lock.yaml`, cae a `npm install`
   y falla (`Cannot read properties of null (reading 'edgesOut')`) porque no hay lockfile de npm.
3. Workflow corregido — compilar nosotros con `pnpm` y decirle a Azure que **no** vuelva a compilar:

```yaml
- uses: pnpm/action-setup@v4
  with:
    package_json_file: frontend/package.json   # respeta "packageManager": "pnpm@10.33.0"

- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: pnpm
    cache-dependency-path: frontend/pnpm-lock.yaml

- name: Install and build
  working-directory: frontend
  run: |
    pnpm install --frozen-lockfile
    pnpm build

- uses: Azure/static-web-apps-deploy@v1
  with:
    azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_<TU_SUFIJO> }}
    repo_token: ${{ secrets.GITHUB_TOKEN }}
    action: "upload"
    app_location: "frontend/dist/frontend/browser"  # ya compilado
    api_location: ""
    output_location: ""
    skip_app_build: true   # evita que Oryx intente compilar de nuevo con npm
```

4. `frontend/src/environments/environment.ts` debe apuntar a la URL pública de la API
   (`apiUrl: 'https://api.TU_DOMINIO/api/v1'`) — al vivir en dominios distintos, ya no aplica la ruta
   relativa `/api/v1` que usaría un proxy same-origin.
5. Cada push a `main` que toque `frontend/` dispara el workflow → build con pnpm → deploy automático.

### Fase 8: Dominio propio y HTTPS con Cloudflare

1. **Agregar el dominio a Cloudflare** y apuntar los nameservers del registrador a los que da Cloudflare.
2. **Subdominio del frontend** (`app.TU_DOMINIO`):
   - En Azure Static Web Apps → **Custom domains** → **Add** → tipo `CNAME` → te da el registro a crear.
   - En Cloudflare DNS: `CNAME app → <tu-swa>.azurestaticapps.net`, modo **Proxied** (nube naranja).
3. **Subdominio de la API** (`api.TU_DOMINIO`):
   - En Cloudflare DNS: `A api → TU_IP_ELASTICA_AQUÍ`, modo **Proxied** (nube naranja).
   - **Certificado de origen** (Cloudflare → **SSL/TLS → Origin Server** → **Create Certificate**):
     genera un par clave/certificado válido ~15 años (solo lo reconoce Cloudflare, no navegadores
     directos). Copiarlos a la EC2:
     ```bash
     sudo mkdir -p /etc/ssl/cloudflare
     sudo nano /etc/ssl/cloudflare/api.TU_DOMINIO.pem   # pegar el certificado
     sudo nano /etc/ssl/cloudflare/api.TU_DOMINIO.key   # pegar la llave privada
     sudo chmod 600 /etc/ssl/cloudflare/api.TU_DOMINIO.key
     sudo nginx -t && sudo systemctl reload nginx
     ```
   - En **SSL/TLS → Overview**, modo **Full**: Cloudflare habla con Nginx por HTTPS (puerto 443)
     usando ese certificado de origen — ya no hay tramo en HTTP plano entre Cloudflare y la EC2.
4. Actualizar `CORS_ORIGIN` en `backend/ecosystem.config.cjs` para incluir `https://app.TU_DOMINIO`, y
   `apiUrl` en `frontend/src/environments/environment.ts` para usar `https://api.TU_DOMINIO/api/v1`.

---

## ✅ Pruebas de verificación y resiliencia

1. **Prueba de red**: abrir `https://app.TU_DOMINIO` en el navegador → debe verse la interfaz Angular
   servida por Azure, consumiendo la API en `https://api.TU_DOMINIO`, ambos con candado HTTPS.
2. **Caída controlada de la API** (hecha ✅): `pm2 stop empleados-backend` en la EC2 → llega una alerta al
   canal de Discord (evento `stop`, activo por defecto en `pm2-discord`). Se restaura con
   `pm2 start empleados-backend` y el frontend vuelve a responder sin redeploy.
3. **Auto-recuperación de un worker del cluster**: con la app en modo `cluster` (`instances: "max"`),
   matar un proceso hijo a la fuerza —
   ```bash
   pm2 list                       # ver los PID de cada worker
   kill -9 <PID_DE_UN_WORKER>
   pm2 list                       # el contador "↺" (restarts) sube y el proceso vuelve a "online" solo
   ```
   Mientras tanto, la API sigue respondiendo porque los demás workers del cluster atienden las peticiones.
4. **Reload sin downtime**: dejar un contador de OK/FAIL corriendo en local mientras se despliega —
   ```bash
   ok=0; fail=0
   while true; do
     code=$(curl -s -o /dev/null -w "%{http_code}" https://api.TU_DOMINIO/api/v1/health)
     if [ "$code" = "200" ]; then ok=$((ok+1)); else fail=$((fail+1)); echo "❌ $code en $(date +%T)"; fi
     printf "\r✅ OK: %d   ❌ FAIL: %d" "$ok" "$fail"
     sleep 0.2
   done
   ```
   y en paralelo, desde el equipo local, `pm2 deploy production`. El contador de `FAIL` debe quedarse en
   `0` (PM2 recarga los workers uno a uno, nunca todos a la vez); detén con `Ctrl+C` cuando termine.
5. **Persistencia tras reinicio del servidor** *(hecha ✅)*: con `pm2 startup` + `pm2 save` ya
   configurados (Fase 5), se reinició la instancia EC2 (`sudo reboot`) y, al reconectar, `pm2 list`
   mostró los procesos `online` sin haber tenido que arrancarlos a mano. Para capturar la evidencia en
   una sola pantalla:
   ```bash
   uptime
   who -b
   pm2 list
   ```
   La hora de `who -b` (último arranque) debe coincidir con el uptime bajo del proceso en `pm2 list` —
   eso prueba que PM2 lo revivió solo.
6. **Degradación controlada del frontend**: con el backend detenido, abrir `https://app.TU_DOMINIO` —
   la interfaz (servida estáticamente desde Azure, independiente de la EC2) sigue cargando y muestra el
   mensaje de error de la petición fallida, en vez de caerse todo el sistema.
7. **Prueba de CI/CD**: hacer un cambio visual en `frontend/` (o un cambio de backend), `git push origin
   main`. El frontend se redespliega solo vía GitHub Actions (Fase 7); para el backend, ejecutar además
   `pm2 deploy production` desde `backend/` en el equipo local. Refrescar y confirmar el cambio sin haber
   tocado la consola de AWS ni de Azure.

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
`http://localhost:3000/api/v1`. En producción, `environment.ts` usa la URL absoluta de la API
(`apiUrl: 'https://api.TU_DOMINIO/api/v1'`), porque el frontend (Azure) y el backend (EC2) son
dominios distintos — ya no hay un Nginx same-origin que resuelva `/api/` por proxy.

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
- El secreto `MONGO_URI` de producción vive únicamente en el servidor (`backend/.env` en la EC2), fuera
  del repositorio y fuera de `ecosystem.config.cjs`.
- El puerto `3000` permanece cerrado al tráfico externo; todo el acceso público a la API pasa por
  Nginx (`443`, HTTPS con certificado de origen) detrás de Cloudflare.
- La llave privada del certificado de origen (`/etc/ssl/cloudflare/*.key`) vive solo en la EC2 con
  permisos `600`; nunca se sube al repositorio.
- El token de despliegue de Azure (`AZURE_STATIC_WEB_APPS_API_TOKEN_...`) vive solo como **secret** de
  GitHub Actions, nunca en el código del workflow ni en el repositorio.

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
- **HTTPS de extremo a extremo**: con el certificado de origen de Cloudflare instalado en Nginx y el
  modo **Full** activo, ya no queda ningún tramo en HTTP plano entre el visitante y la API.

## 📌 Recomendaciones para un entorno real

- **Base de datos externalizada**: usar un servicio administrado (p. ej. **MongoDB Atlas**, ya en uso, o
  AWS RDS) en vez de instalar la base de datos en la misma instancia EC2 que la aplicación.
- **Rate limiting y `trust proxy`**: el backend está detrás de Nginx y Cloudflare pero no declara
  `app.set('trust proxy', 1)` ni tiene `express-rate-limit`; sin esto, `req.ip` no refleja la IP real del
  visitante y la API queda sin límite de peticiones.
- **CI con verificación previa**: agregar un job de GitHub Actions que corra `pnpm lint`/`typecheck`/`test`
  en cada Pull Request antes de permitir el merge a `main`, ya que hoy `pm2 deploy` despliega
  directamente lo que haya en esa rama sin ninguna validación automática previa.
