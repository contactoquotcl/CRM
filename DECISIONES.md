# DECISIONES.md — Chatbot + Chatwoot + WooCommerce

Registro de decisiones tomadas de forma autónoma (donde faltaba un dato se eligió un valor razonable, configurable por variable de entorno). Se actualiza al cierre de cada fase.

## Fase 1 (catálogo + chatbot de búsqueda/ficha + widget + derivación + bandeja básica)

| # | Tema | Decisión | Configurable |
|---|---|---|---|
| 1 | Búsqueda | Full-text de Postgres en español (`tsvector`) sobre texto sin tildes + tabla de sinónimos (etiqueta/label, lector/escáner, stretch/film…). **No se usa pgvector**: el Postgres gratuito de Render no garantiza la extensión y el catálogo es pequeño. Ranking: SKU exacto > todos los términos > relevancia. | Sinónimos en `src/catalog.js` |
| 2 | Dirección de sincronización | **WooCommerce → CRM, solo lectura.** WooCommerce es la fuente del precio público y del stock. El catálogo local existe solo para buscar; la maestra de productos del CRM conserva costos y margen. Clave de unión: SKU (el panel "Diferencias de catálogo" llega en la Fase 3). | — |
| 3 | Precio y stock | **Siempre en vivo**: `ver_producto` consulta WooCommerce en cada uso; `buscar_productos` no devuelve precios. Si WooCommerce no responde, el bot no da precios y ofrece derivar. | — |
| 4 | IVA | Los precios de la tienda se asumen **netos** (el CRM cotiza neto + IVA). El bot informa neto y con IVA 19 % calculados en código. | `WC_PRICES_INCLUDE_TAX=true` si la tienda ya incluye IVA |
| 5 | Modelo | `claude-sonnet-5-5`, máx. 6 vueltas de herramientas por mensaje, 30 mensajes de historial. | `CHATBOT_MODEL`, `BOT_MAX_TOOL_ITERATIONS` |
| 6 | Herramientas | `buscar_productos`, `ver_producto`, `derivar_ejecutivo`. Argumentos validados estrictamente en código (tipos, largos, RUT con dígito verificador, correo, teléfono). `armar_carrito` y `generar_cotizacion` llegan en la Fase 2; mientras tanto, ante una cotización el bot junta datos y deriva (`motivo = cotizacion`). | — |
| 7 | Reglas duras (en código, no en el prompt) | (a) Cualquier monto en pesos de una respuesta que no provenga de una herramienta de esa conversación (ni del propio cliente) se **bloquea** y se reemplaza por una oferta de derivar; (b) se eliminan enlaces a dominios que no sean quot.cl/WooCommerce; (c) el bot no tiene herramienta de descuentos; (d) reglas comerciales centralizadas: validez 30 días, entrega 15–20 días hábiles tras el pago, despacho gratis en RM y por cuenta del comprador en regiones. | `BOT_QUOTE_VALIDITY_DAYS`, `BOT_DELIVERY_TEXT`, `BOT_SHIPPING_TEXT`, `BOT_MIN_ORDER_CLP` |
| 8 | Derivación (disparadores) | (1) el cliente la pide (detección determinista por patrones, sin pasar por el modelo); (2) frustración (palabras, `!!!`, mayúsculas); (3) 2 fallos seguidos (error del modelo, monto bloqueado, búsquedas sin resultado); (4) el modelo llama a `derivar_ejecutivo`; (5) sin clave de IA configurada. El umbral por monto de cotización llega con la Fase 2. | `BOT_MAX_FAILS` (2) |
| 9 | Asignación | Round-robin entre usuarios **activos** del CRM (admin y estándar), puntero guardado en `settings`. En Chatwoot se asigna al agente con el **mismo correo**; si no existe, queda asignado solo en el CRM. | — |
| 10 | Lead de la derivación | Si el cliente dejó nombre, correo, teléfono o RUT, se crea (o se actualiza por RUT/correo) un lead, canal `Chatbot`, creador `Bot`, en el estado inicial del pipeline, con el resumen en comentarios. | `CHATBOT_HANDOFF_LEAD_STATE` |
| 11 | Chatwoot | Inbox de tipo **API**. El backend crea contacto (`identifier = crm-session:<id>`) y conversación `pending`; al derivar pasa a `open`, se asigna, se deja **nota privada** con resumen + datos + últimos mensajes y se etiqueta `derivado`. Los mensajes enviados por el CRM llevan `source_id = crm:<id>` para evitar duplicados con el webhook. El Agent Bot se registra en la UI (ver docs/INTEGRACIONES.md). | `CHATWOOT_*` |
| 12 | Webhooks de Chatwoot | `/api/chatwoot/webhook`: firma HMAC (`X-Chatwoot-Signature`, ventana de 5 min) **o** `?token=` (versiones sin firma). **Falla cerrado** si no hay secreto. Idempotente (por id de mensaje). Procesa `message_created`, `conversation_created`, `conversation_updated`, `conversation_status_changed`; crea conversaciones de otros canales (ej. WhatsApp) si llegan. | `CHATWOOT_WEBHOOK_SECRET` |
| 13 | Webhooks de WooCommerce | `/api/woo/webhook`: firma HMAC-SHA256 base64 (`X-WC-Webhook-Signature`) sobre el cuerpo crudo; `product.created/updated/deleted`; un producto despublicado sale del catálogo; responde al *ping* inicial. `order.*` se ignora hasta la Fase 3. | `WC_WEBHOOK_SECRET` |
| 14 | Modo local | Sin `CHATWOOT_*` todo funciona dentro del CRM (útil para pruebas). Si Chatwoot falla al enviar una respuesta del ejecutivo, se informa el error (502) y **no** queda un mensaje "fantasma". | — |
| 15 | Seguridad del endpoint público | Sesión anónima con token JWT firmado (24 h); CORS solo `quot.cl`/`www.quot.cl` (y rechazo 403 de otros orígenes); límites por IP (40/min), por sesión (12/min), 20 sesiones nuevas/hora por IP, 80 mensajes por conversación, 1000 caracteres por mensaje; un turno a la vez por sesión; interruptor desde Admin; resultados de herramientas marcados como datos no confiables; log de cada tool call (`chat_tool_calls`). No se guardan datos sensibles: solo lo que el cliente escribe, y se le advierte no compartir claves ni datos de pago. | `CHATBOT_ALLOWED_ORIGINS`, `BOT_RATE_*` |
| 16 | Permisos de la bandeja | Admin ve todo. Usuario estándar ve **solo las asignadas a él y las sin asignar**; puede tomar una libre o soltar una suya, pero no reasignar a terceros. La API key de Chatwoot nunca sale del backend; el frontend no habla con Chatwoot. | — |
| 17 | Tiempo real | **Polling corto** (bandeja 4–5 s, widget 3 s tras derivar, badge 15 s). SSE/WebSocket se pospone: con el plan gratuito de Render y proxies intermedios es frágil, y el polling cubre el caso con latencia aceptable. | — |
| 18 | Notificaciones | Badge de no leídas en el menú. El correo opcional queda para la Fase 3. | — |
| 19 | Alcance diferido | Adjuntos, etiquetas editables, panel lateral del cliente y "generar cotización desde la conversación" (Fase 2); horario, reglas de asignación, métricas y órdenes de WooCommerce (Fase 3). No se usó iframe + SSO de Chatwoot: la bandeja nativa ya está en esta fase. | — |
| 20 | Usuario "Bot" | Usuario técnico inactivo (`bot@quot.invalid`): no inicia sesión ni recibe conversaciones; solo atribuye lo que crea el bot. | — |

### Infraestructura (Render)
Ver `docs/INTEGRACIONES.md §5`. Resumen: el plan gratuito duerme la API y rompe el chat y los webhooks; solución mínima = **API en `starter`** + base de datos de pago antes del **19-nov-2026**. Se dejó un *keep-alive* gratis como paliativo.

### Pendiente de cargar por el dueño (Fase 1)
`ANTHROPIC_API_KEY`, `WC_BASE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `WC_WEBHOOK_SECRET`, `CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN`, `CHATWOOT_INBOX_ID`, `CHATWOOT_WEBHOOK_SECRET`, `CRM_PUBLIC_URL` (todas en Render → Environment). Frontend (Vercel): no hay variables nuevas.

### Calidad
- 19 pruebas de integración (`backend/test/`): catálogo, webhooks WC y Chatwoot (firma válida e inválida), bot con tool use, reglas duras, derivación, round-robin, permisos por rol, CORS/rate limit.
- Evaluación con 20 casos (`backend/eval/`): **no se ejecutó contra el modelo real** (no hay clave en este entorno); el arnés está validado en modo simulado.
- Smoke con Playwright (`e2e/smoke.py`): widget → bot → derivación → bandeja → respuesta → pipeline. OK.
