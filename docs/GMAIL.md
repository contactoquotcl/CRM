# Conectar Gmail (contacto@quot.cl) para los seguimientos

El CRM envía los correos **desde la propia casilla** (quedan en «Enviados») usando la API de Gmail por HTTPS, así que funciona también en el plan gratis de Render. Además detecta cuando el cliente responde y pausa el seguimiento.

Se hace una sola vez (≈10 minutos), con la sesión de contacto@quot.cl:

1. Entra a https://console.cloud.google.com con esa cuenta y crea un proyecto (ej. «Quot CRM»).
2. **APIs y servicios → Biblioteca → Gmail API → Habilitar.**
3. **APIs y servicios → Pantalla de consentimiento OAuth.** Si Quot usa Google Workspace elige tipo **Interno** (no requiere revisión de Google y el token no vence). Si es un Gmail personal, elige Externo, agrégate como usuario de prueba y **publícala («En producción»)**; en modo prueba el token vence a los 7 días.
4. **Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación web.** En «URI de redireccionamiento autorizados» agrega `https://developers.google.com/oauthplayground`. Copia el **ID de cliente** y el **secreto**.
5. Abre https://developers.google.com/oauthplayground → engranaje ⚙ → marca **Use your own OAuth credentials** y pega ID y secreto.
6. En «Step 1» escribe estos permisos y pulsa Authorize APIs (acepta con contacto@quot.cl):
   `https://www.googleapis.com/auth/gmail.send` y `https://www.googleapis.com/auth/gmail.readonly`
7. «Step 2» → **Exchange authorization code for tokens** → copia el **Refresh token**.
8. En el CRM: **Admin → Integraciones (claves) → Correo de seguimiento**: Servicio = «Gmail de Quot», pega ID de cliente, secreto y refresh token, correo remitente `contacto@quot.cl`, Guardar y **Probar conexión** (te llega un correo de prueba).

Si el refresh token deja de funcionar (Google lo revoca al cambiar la clave de la cuenta o si la pantalla quedó en modo prueba), repite los pasos 5–7 y pega el nuevo.
