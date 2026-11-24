/**
 * Servidor estático ligero sin dependencias externas para ejecutar `web-demo/`
 * localmente resolviendo módulos ES (`../src/domain/*`) con encabezados MIME exactos.
 * Se evita Express/Vite para garantizar arranque instantáneo en cualquier entorno de evaluación.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT_PREFIX = ROOT_DIR.endsWith(sep) ? ROOT_DIR : `${ROOT_DIR}${sep}`;
const PORT = Number(process.env.PORT || 4173);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml'
};

createServer(async (req, res) => {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ruta malformada');
    return;
  }

  if (decodedPath === '/') {
    res.writeHead(302, { Location: '/web-demo/index.html' });
    res.end();
    return;
  }

  const relativePath = decodedPath;

  // Bloquea acceso a carpetas/archivos ocultos (.git, .env, .github)
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acceso denegado');
    return;
  }

  const safePath = normalize(join(ROOT_DIR, relativePath));

  // Previene escalamiento de directorios y colisiones de prefijo parcial (CWE-22)
  if (!safePath.startsWith(ROOT_PREFIX)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acceso denegado');
    return;
  }

  try {
    const content = await readFile(safePath);
    const mime = MIME_TYPES[extname(safePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Recurso no encontrado');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Simulador IngresoCerteza activo en http://127.0.0.1:${PORT}/web-demo/index.html`);
});
