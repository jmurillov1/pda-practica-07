module.exports = {
  apps: [{
    name: "empleados-backend",
    script: "./index.js",
    instances: "max",
    exec_mode: "cluster",
    env: {
      NODE_ENV: "production",
      PORT: 3000
    },
    error_file: "/var/www/empleados-backend/logs/err.log",
    out_file: "/var/www/empleados-backend/logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    merge_logs: true
  }],
  deploy: {
    production: {
      user: 'ubuntu',
      host: '44.215.90.212',
      ref: 'origin/main',
      repo: 'git@github.com:jmurillov1/pda-practica-07.git',
      path: '/var/www/empleados-backend',
      'post-deploy': 'mkdir -p logs && npm install && pm2 reload ecosystem.config.js --env production && pm2 save',
      ssh_options: "IdentityFile=~/.ssh/svr-01.pem",
    }
  }
};