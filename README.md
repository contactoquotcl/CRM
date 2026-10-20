# Quot CRM

Mini CRM de Quot.cl: pipeline de cotizaciones, maestra de productos, cotizador con PDF y correlativo, usuarios admin/estándar.

- **Frontend**: React + Vite → Vercel (`frontend/`)
- **Backend**: Node + Express + Postgres → Render (`backend/`)
- **Código**: GitHub

## Funciones

| Módulo | Qué hace |
|---|---|
| Pipeline | Tablero (arrastrar y soltar) y tabla; estados configurables por el admin |
| Cotizador | Datos del cliente (RUT validado, razón social, correo, contacto, teléfono) + ítems desde la maestra o libres → PDF con **correlativo** → crea el lead en estado **Cotizado** |
| Cotizaciones | Listado y re-descarga de PDF |
| Productos | Maestra con SKU, nombre, descripción y precio neto (CLP); import CSV por SKU |
| Importar (admin) | CSV de Notion → mapeo de columnas → leads; reimportable sin duplicar |
| Admin | Usuarios y roles, estados del pipeline, datos de empresa, IVA, próximo N° de cotización |

**Roles.** *Administrador*: todo. *Estándar*: pipeline (crear/editar/mover leads), cotizador y cotizaciones; solo lectura de productos; no accede a usuarios, estados, importación ni configuración.

## Desarrollo local

```bash
# API (usa Postgres embebido; crea admin@quot.cl / cambiar123)
cd backend && npm install && npm run dev      # http://localhost:4000
npm test                                      # pruebas de integración

# Frontend
cd frontend && npm install && npm run dev     # http://localhost:5173 (proxy /api → :4000)
```

## Despliegue

1. **GitHub**: sube este repo (`git remote add origin … && git push -u origin main`).
2. **Render**: *New → Blueprint* y elige el repo (usa `render.yaml`). Te pedirá `ADMIN_EMAIL`, `ADMIN_PASSWORD` y `CORS_ORIGIN` (puedes poner temporalmente cualquier valor en `CORS_ORIGIN` y corregirlo después). Crea la API y la base Postgres; las tablas se crean solas al arrancar. Anota la URL de la API.
3. **Vercel**: *Add New Project* → mismo repo → **Root Directory `frontend`**. Variable de entorno `VITE_API_URL` = URL de la API en Render (sin `/` final).
4. Vuelve a Render y pon `CORS_ORIGIN` = URL de Vercel (si usas dominio propio, agrégalo separado por coma). Redeploy.
5. Entra con `ADMIN_EMAIL` / `ADMIN_PASSWORD` y cambia la clave desde tu nombre (arriba a la derecha).

## Migrar el pipeline desde Notion

Notion → base **Cotizaciones Quot 2026** → `···` → Exportar → CSV. En el CRM: **Importar** → subir archivo → revisar mapeo (se detectan las columnas de Notion automáticamente) → Importar. Los estados que no existan se crean; los leads se identifican por **N° Correlativo**, así que puedes reimportar y se actualizan. Al terminar, el correlativo del cotizador continúa tras el mayor N° de cotización importado (se puede ajustar en Admin → Empresa y cotizador).

## Notas

- Montos en CLP enteros, precios **netos**; IVA configurable (19 %).
- El correlativo se incrementa de forma atómica en la base de datos (no hay saltos ni duplicados con usuarios simultáneos).
- El PDF se genera al vuelo con PDFKit desde los datos guardados, así que siempre se puede volver a descargar.
