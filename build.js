// Assembles a single self-contained HTML file from src/.
//   node build.js          -> dist/index.html (full page, for GitHub Pages or any web host)
//   also writes dist/fragment.html (body-only version used for the Claude artifact preview)
const fs = require('fs'); const r = (p) => fs.readFileSync(__dirname + '/src/' + p, 'utf8');
const head = `<title>NYC School District Builder</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Draw your own New York City community school districts with real DOE enrollment and demographic data.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Public+Sans:wght@400;600;700&display=swap">
<style>${r('app.css')}</style>`;
const scripts = `<script>window.DATA=${r('data.json')};window.PRESETS=${r('presets.json')};</script>
<script>${r('engine.js')}</script>
<script>${r('app.js')}</script>`;
fs.mkdirSync(__dirname + '/dist', { recursive: true });
fs.writeFileSync(__dirname + '/dist/fragment.html', `${head}\n${r('body.html')}\n${scripts}\n`);
fs.writeFileSync(__dirname + '/dist/index.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
${head}</head><body>
${r('body.html')}
${scripts}
</body></html>
`);
console.log('built', (fs.statSync(__dirname + '/dist/index.html').size / 1024).toFixed(0), 'KB');
