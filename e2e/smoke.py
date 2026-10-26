"""Smoke test de punta a punta: widget (cliente) → bot → derivación → aparece en la bandeja del CRM → el ejecutivo responde → llega al widget.
Usa servidores falsos de WooCommerce/Chatwoot/Anthropic (backend/scripts/dev-stack.mjs): no necesita credenciales.
Uso:  python3 e2e/smoke.py [directorio_de_capturas]
"""
import os, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
API = 'http://127.0.0.1:4000'
procs = []

class Site(BaseHTTPRequestHandler):  # sitio falso "quot.cl" con el <script> del widget
    def do_GET(self):
        body = f'<html><body><h1>Quot.cl (sitio de prueba)</h1><script src="{API}/widget.js" data-api="{API}" defer></script></body></html>'.encode()
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass

def wait_http(url, secs=40):
    t0 = time.time()
    while time.time() - t0 < secs:
        try:
            urllib.request.urlopen(url, timeout=2); return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f'no respondió: {url}')

site_srv = HTTPServer(('127.0.0.1', 5180), Site)
threading.Thread(target=site_srv.serve_forever, daemon=True).start()
try:
    procs.append(subprocess.Popen(['node', 'scripts/dev-stack.mjs'], cwd=f'{ROOT}/backend', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    wait_http(f'{API}/health')
    procs.append(subprocess.Popen(['npx', 'vite', '--port', '5173', '--strictPort'], cwd=f'{ROOT}/frontend', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    wait_http('http://localhost:5173/')

    with sync_playwright() as p:
        b = p.chromium.launch()

        # ---- Cliente en el sitio (página falsa que simula quot.cl; va en loopback para evitar el bloqueo de red privada de Chrome)
        cust = b.new_context(viewport={'width': 1100, 'height': 760})
        site = cust.new_page()
        site.goto('http://localhost:5180/')
        site.locator('.fab').click()
        chat = lambda sel: site.locator(f'.panel {sel}')
        expect(site.locator('.m.bot').first).to_contain_text('asistente virtual de Quot')

        site.locator('textarea').fill('busco etiquetas térmicas 100x150')
        site.keyboard.press('Enter')
        expect(site.locator('.m.bot').last).to_contain_text('$5.490', timeout=15000)   # precio vivo desde WooCommerce
        expect(site.locator('.m.bot').last).to_contain_text('https://quot.cl/producto/etq-100x150-td/')
        site.screenshot(path=f'{OUT}/1-widget-bot.png')

        site.locator('textarea').fill('mi correo es cliente@empresa.cl, quiero hablar con un ejecutivo')
        site.keyboard.press('Enter')
        expect(site.locator('.m.sys').last).to_contain_text('ejecutivo de Quot te atenderá', timeout=15000)
        site.screenshot(path=f'{OUT}/2-widget-derivado.png')

        # ---- Ejecutivo en el CRM
        agent = b.new_context(viewport={'width': 1400, 'height': 800})
        crm = agent.new_page()
        crm.goto('http://localhost:5173/')
        crm.fill('input[type=email]', 'admin@quot.test'); crm.fill('input[type=password]', 'admin-pass-123'); crm.keyboard.press('Enter')
        expect(crm.locator('.nav-badge')).to_have_text('1', timeout=15000)               # badge de no leídas
        crm.get_by_role('link', name='Conversaciones').click()
        row = crm.locator('.inbox-row').first
        expect(row).to_contain_text('cliente@empresa.cl')
        row.click()
        expect(crm.locator('.bubble.in').first).to_contain_text('busco etiquetas')
        expect(crm.locator('.bubble.bot').first).to_contain_text('$5.490')
        expect(crm.locator('.bubble.note')).to_contain_text('Derivación desde el chatbot')
        crm.screenshot(path=f'{OUT}/3-bandeja.png')

        crm.locator('.chat-compose textarea').fill('Hola, soy del equipo de Quot, te ayudo con tu cotización')
        crm.get_by_role('button', name='Enviar').click()
        expect(crm.locator('.bubble.out').last).to_contain_text('te ayudo con tu cotización')

        # ---- El cliente ve la respuesta del ejecutivo en el widget (polling)
        expect(site.locator('.m.agent').last).to_contain_text('te ayudo con tu cotización', timeout=15000)
        site.screenshot(path=f'{OUT}/4-widget-respuesta-ejecutivo.png')

        # ---- Pipeline: el lead nació desde el chat
        crm.get_by_role('link', name='Pipeline').click()
        expect(crm.locator('.lead-card', has_text='cliente@empresa.cl')).to_be_visible(timeout=10000)
        b.close()
    print('SMOKE OK')
finally:
    site_srv.shutdown()
    for pr in procs:
        pr.terminate()
    for pr in procs:
        try: pr.wait(timeout=5)
        except Exception: pr.kill()
