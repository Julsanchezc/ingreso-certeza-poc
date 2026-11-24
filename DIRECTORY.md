# DIRECTORY.md — Mapa de Navegación del Repositorio

Índice estructural de `ingreso-certeza-poc` para inspección rápida de módulos y responsabilidades.

- `.github/workflows/ci.yml` — Pipeline de integración continua en GitHub Actions con permisos de solo lectura y ejecución automática de `npm test`.
- `package.json` — Manifiesto ESM sin dependencias de terceros (`npm test` y `npm run demo`).
- `scripts/serve-demo.mjs` — Servidor HTTP local con protección contra escalamiento de rutas para servir `web-demo/` e importar `src/domain/`.
- `db/`
  - `db/schema.sql` — Modelo relacional PostgreSQL 16 normalizado, triggers de auditoría inmutable, políticas RLS y soporte LFPDPPP.
  - `db/seed_demo.sql` — Datos semilla representativos de operación aseguradora multi-ramo.
- `src/domain/`
  - `src/domain/constants.mjs` — Definición de los 7 ramos iniciales, 7 etapas comerciales, roles RBAC y alta dinámica de productos.
  - `src/domain/commissionEngine.mjs` — Precedencia de reglas de comisión por prospectador y cálculo por estatus comercial.
  - `src/domain/stageMachine.mjs` — Gestión de expedientes, venta cruzada multi-negocio e invariantes de avance de etapa.
  - `src/domain/whatsappNotifier.mjs` — Normalización E.164 y plantillas estructuradas para Meta WhatsApp Cloud API y notificaciones Push.
  - `src/domain/kpiAnalytics.mjs` — Agregaciones del embudo comercial, estancamiento por etapa, ranking de referidores y métricas por ramo.
  - `src/domain/index.mjs` — Fachada pública del dominio y generador del estado demostrativo inicial.
- `tests/`
  - `tests/domain.test.mjs` — Suite determinista de pruebas unitarias sobre reglas de negocio y casos límite.
- `web-demo/`
  - `web-demo/index.html` — Interfaz unificada con conmutador de rol (App Prospectador, App Vendedor y Panel Administrativo Web).
  - `web-demo/styles.css` — Hoja de estilos responsiva con marcos móviles y panel analítico ejecutivo.
  - `web-demo/app.mjs` — Controlador reactivo en el cliente conectado directamente a `src/domain/index.mjs`.
- `docs/`
  - `docs/ARCHITECTURE.md` — Registro de decisiones arquitectónicas (ADR), diagrama ER y patrón Transactional Outbox.
