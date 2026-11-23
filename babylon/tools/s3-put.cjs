const fs = require('fs');
const u = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const zip = 'C:/Users/victor/Desktop/Projects/games/digital_game/antiskleroz-playgama.zip';
const body = fs.readFileSync(zip);
fetch(u.uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/zip', 'Content-Length': String(body.length) },
  body,
}).then(async (r) => {
  console.log('PUT status', r.status);
  console.log((await r.text()).slice(0, 300));
});
