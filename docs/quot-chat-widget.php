<?php
/**
 * Plugin Name: Quot Chat Widget
 * Description: Inserta el asistente de chat de Quot (bot + ejecutivos) en todas las páginas del sitio.
 * Version: 1.0.0
 *
 * Instalación: guarda este archivo como wp-content/plugins/quot-chat-widget/quot-chat-widget.php,
 * cambia QUOT_CHAT_API por la URL de tu API en Render y activa el plugin en WordPress.
 */
if (!defined('ABSPATH')) exit;

define('QUOT_CHAT_API', 'https://TU-API.onrender.com');

add_action('wp_enqueue_scripts', function () {
    if (is_admin()) return;
    wp_enqueue_script('quot-chat', QUOT_CHAT_API . '/widget.js', [], '1.0.0', ['in_footer' => true, 'strategy' => 'defer']);
});
