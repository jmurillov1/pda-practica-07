import { Router } from 'express';
import type { EmployeeController } from '../controllers/employee.controller.js';
import { createEmployeeRouter } from './employee.routes.js';
import { getDatabaseStatus } from '../config/database.js';
import { ok } from '../utils/response.js';

export const createApiRouter = (employee: EmployeeController): Router => {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({
      success: true,
      data: { status: 'ok', database: getDatabaseStatus() },
      message: 'Servicio operativo',
    });
  });

  // Endpoint de prueba para verificar el pipeline de CI/CD (pm2 deploy):
  router.get('/saludo', (_req, res) => {
    ok(res, { mensaje: '¡Hola desde producción! 👋' }, 'Saludo generado v2');
  });

  router.use(createEmployeeRouter(employee));

  return router;
};
