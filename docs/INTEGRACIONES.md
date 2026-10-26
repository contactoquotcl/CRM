# Integraciones: WooCommerce, Chatwoot, chatbot y widget

Guía de puesta en marcha de la Fase 1. Todos los valores secretos se cargan **solo en Render → Environment** (nunca en el repositorio).

## 1. Variables de entorno (Render, servicio `quot-crm-api`)

| Variable | Obligatoria | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | sí | Clave de la API de Claude. Sin ella el chat deriva todo a un ejecutivo. |
| `WC_BASE_URL` | sí | URL de la tienda, ej. `https://quot.cl` |
| `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET` | sí | Claves REST de WooCommerce con permiso **solo lectura** |
| `WC_WEBHOOK_SECRET` | sí | Secreto de los webhooks de WooCommerce (lo inventas tú: cadena larga aleatoria) |
| `CHATWOOT_BASE_URL` | sí | `https://app.chatwoot.com` (Cloud) o la URL de tu instancia |
| `CHATWOOT_ACCOUNT_ID` | sí | N° de cuenta (sale en la URL: `/app/accounts/<N>/…`) |
| `CHATWOOT_API_TOKEN` | sí | Token de acceso del agente integrador (Perfil → Token de acceso). Vive solo en el backend |
| `CHATWOOT_INBOX_ID` | sí | ID del inbox tipo "API" creado para el sitio |
| `CHATWOOT_WEBHOOK_SECRET` | sí | Secreto compartido (cadena aleatoria) para validar los webhooks de Chatwoot |
| `CRM_PUBLIC_URL` | recomendada | URL del CRM en Vercel; se usa para el link en las notas de derivación |
| `CHATBOT_ALLOWED_ORIGINS` | ya definida | `https://quot.cl,https://www.quot.cl` (CORS del endpoint público del bot) |
| `WC_PRICES_INCLUDE_TAX` | opcional | `true` si los precios de la tienda ya incluyen IVA (por defecto `false` = precio neto) |
| `CHATBOT_MODEL` | opcional | Modelo de Claude (por defecto `claude-sonnet-5-5`) |
| `CHATBOT_HANDOFF_LEAD_STATE` | opcional | Estado del pipeline para leads nacidos de una derivación (por defecto, el inicial) |
| `BOT_*` | opcionales | Límites y reglas comerciales; ver `backend/.env.example` |

> Si falta `CHATWOOT_*` el sistema funciona en **modo local**: las conversaciones viven solo en el CRM (sin Chatwoot). Si falta `WC_*`, el bot no da precios (deriva).

## 2. WooCommerce

1. **Claves API (solo lectura):** WooCommerce → Ajustes → Avanzado → API REST → *Añadir clave* → permisos **Lectura** → copia Consumer key/secret a `WC_CONSUMER_KEY/SECRET`.
2. **Webhooks:** WooCommerce → Ajustes → Avanzado → Webhooks → *Añadir webhook* (uno por tema):
   - Temas: `Producto creado`, `Producto actualizado`, `Producto eliminado` (en la Fase 3 se suman `Pedido creado/actualizado`).
   - URL de entrega: `https://TU-API.onrender.com/api/woo/webhook`
   - Secreto: el mismo valor de `WC_WEBHOOK_SECRET`. Versión de API: *WP REST API Integration v3*.
3. **Carga inicial:** al arrancar con `WC_*` cargadas y el catálogo vacío, la API sincroniza sola. También puedes usar **Admin → Chatbot y catálogo → Sincronizar catálogo ahora**. Además se reconcilia cada 24 h (o al despertar si el servicio estuvo dormido más de ese tiempo).

## 3. Chatwoot

**Recomendado: Chatwoot Cloud** (cero mantención). Alternativa propia: `docs/chatwoot-docker-compose.yml` (referencia **no probada**; revisa la guía oficial de Chatwoot para la versión vigente; necesita un servidor con ≥ 2 GB de RAM).

Configuración inicial (una vez):
1. **Agentes:** crea en Chatwoot un agente por cada usuario del CRM **con el mismo correo** (así la asignación del CRM se refleja en Chatwoot). Crea además un agente administrador "CRM Integración": su *Token de acceso* es `CHATWOOT_API_TOKEN`.
2. **Inbox:** Ajustes → Bandejas de entrada → *Agregar* → canal **API** (nombre "Sitio web Quot"). Anota su ID en `CHATWOOT_INBOX_ID`.
3. **Webhook de la cuenta:** Ajustes → Integraciones → Webhooks → URL
   `https://TU-API.onrender.com/api/chatwoot/webhook?token=<CHATWOOT_WEBHOOK_SECRET>`
   con los eventos `conversation_created`, `conversation_status_changed`, `conversation_updated`, `message_created`.
   (Si tu versión firma los webhooks, se valida la firma HMAC `X-Chatwoot-Signature`; si no, se valida el `?token=`.)
4. **Agent Bot:** Ajustes → Integraciones → Bots → *Nuevo bot* "Asistente Quot", URL de salida = la misma URL del paso 3 → en el inbox, *Configuración* → asignar ese bot. Así las conversaciones en atención del bot quedan **pendientes (pending)** y al derivar pasan a **abiertas (open)**.
5. Los ejecutivos **no entran a Chatwoot**: usan **Conversaciones** dentro del CRM.

## 4. Widget en quot.cl

Opción A (una línea, pegada en el tema o con un plugin de "scripts en el pie"):

```html
<script src="https://TU-API.onrender.com/widget.js" defer></script>
```

Opción B (mini plugin): `docs/quot-chat-widget.php` → copiar a `wp-content/plugins/quot-chat-widget/`, editar la URL y activar.

Opcionales en la etiqueta: `data-title="Quot · Asistente"`, `data-color="#1d4ed8"`, `data-api="https://…"`.
Para apagar el bot sin tocar el sitio: **Admin → Chatbot y catálogo → desmarcar "Chatbot activo"**.

## 5. Render plan gratuito: impacto y solución mínima

**Qué pasa hoy (plan `free`):** la API se duerme a los 15 min sin tráfico y despertarla tarda ≈ 30–60 s.

| Función | Efecto con la API dormida |
|---|---|
| Chat del sitio | El primer mensaje del día queda ~1 minuto "escribiendo…"; el cliente probablemente se va. |
| Webhooks de Chatwoot (mensajes del ejecutivo al cliente, estados) | Llegan a una API dormida: Chatwoot usa timeouts cortos y no garantiza reintentos → se pueden **perder** mensajes/eventos. |
| Webhooks de WooCommerce | Pueden fallar al despertar; WooCommerce desactiva un webhook tras varios fallos seguidos. La reconciliación diaria lo cubre en parte. |
| Reconciliación diaria del catálogo | El temporizador no corre dormida; se compensa sincronizando al despertar si pasó más de 24 h. |
| Base de datos | El Postgres **gratuito vence a los 30 días** (≈ **19-nov-2026**): perderías catálogo, conversaciones y leads. |

**Solución mínima recomendada:** subir **solo la API a `starter`** (siempre encendida; ≈ US$ 7/mes, verifica en render.com/pricing) y pasar la base de datos a un plan de pago (obligatorio antes del vencimiento). En `render.yaml`: `plan: starter` en el servicio web y un plan de pago en la base. No hace falta un servicio aparte para el bot mientras el tráfico sea moderado.

**Paliativo gratis (no recomendado para producción):** `.github/workflows/keepalive.yml` hace ping a `/health` cada 10 min (crear la variable `API_URL` en GitHub). Limitaciones: GitHub puede retrasar/saltarse ejecuciones y desactiva los workflows programados tras 60 días sin actividad en el repo; además, Render da ~750 horas gratis al mes por workspace, así que mantener una API 24/7 consume casi todo y otros servicios gratuitos del mismo workspace podrían suspenderse. No resuelve el vencimiento de la base de datos.

## 6. Cómo probar todo sin credenciales reales

- `npm test` (en `backend/`): 19 pruebas de integración con servidores falsos de WooCommerce, Chatwoot y Anthropic.
- `python3 e2e/smoke.py <carpeta de capturas>`: flujo completo en un navegador (widget → bot → derivación → bandeja → respuesta del ejecutivo → pipeline).
- `ANTHROPIC_API_KEY=… node eval/run.mjs`: evalúa el bot real con 20 casos de Quot y escribe `eval/report.md` (con `--mock` solo se valida el arnés).
