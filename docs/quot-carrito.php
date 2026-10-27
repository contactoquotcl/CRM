<?php
/**
 * Fragmento «Carrito Quot» (WPCode → Añadir fragmento → PHP Snippet → Ejecutar en todas partes).
 * En WPCode pega SOLO el contenido desde add_action(...) hacia abajo (sin la etiqueta <?php).
 *
 * Para qué: el bot arma carritos con varios productos y entrega un solo enlace
 *   https://quot.cl/?quot_cart=ID:CANTIDAD,ID:CANTIDAD
 * que este fragmento convierte en el carrito de la tienda y lleva al checkout.
 * Seguridad: máximo 20 líneas y 999 unidades por línea; solo agrega productos publicados y comprables.
 * Reemplaza el carrito actual del visitante (el carrito del bot es el pedido completo).
 */
add_action('template_redirect', function () {
    if (empty($_GET['quot_cart']) || !function_exists('WC') || is_admin()) return;
    $pairs = array_slice(explode(',', sanitize_text_field(wp_unslash($_GET['quot_cart']))), 0, 20);
    if (null === WC()->cart) wc_load_cart();
    WC()->cart->empty_cart();
    foreach ($pairs as $pair) {
        $parts = explode(':', $pair);
        $id  = absint($parts[0] ?? 0);
        $qty = min(999, max(1, absint($parts[1] ?? 1)));
        $product = $id ? wc_get_product($id) : null;
        if ($product && $product->is_purchasable() && 'publish' === get_post_status($id)) {
            WC()->cart->add_to_cart($id, $qty);
        }
    }
    wp_safe_redirect(wc_get_checkout_url());
    exit;
});
