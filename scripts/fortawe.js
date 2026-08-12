cat << 'EOF' > server.js
const http = require('http');
const server = http.createServer((req, res) => {
    if (req.url === '/api/list-ikon') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
            {name:'user', path:'M256 288A144 144 0 1 0 256 0a144 144 0 1 0 0 288zm-94.7 32C72.2 320 0 392.2 0 481.3C0 498.3 13.7 512 30.7 512H481.3c17 0 30.7-13.7 30.7-30.7C512 392.2 439.8 320 350.7 320H161.3z'},
            {name:'heart', path:'M47 241.5C18.1 273.4 0 315.8 0 362.3C0 445.2 66.8 512 149.7 512c52.2 0 98-26.7 124.9-67C301.5 485.3 347.3 512 399.5 512C482.5 512 549.3 445.2 549.3 362.3c0-46.5-18.1-88.9-47-120.8L281.2 13c-5-5.2-13.2-5.2-18.2 0L47 241.5z'},
            {name:'house', path:'M575.8 255.5c0 18-15 32.1-34 32.1h-32l.7 160.2c0 35.3-28.7 64-64 64H384c-17.7 0-32-14.3-32-32V352H192v128c0 17.7-14.3 32-32 32H64c-35.3 0-64-28.7-64-64L0 287.6H32c-19 0-34-14.1-34-32.1c0-9 3.5-17.6 10-24L251.6 5.7c12.5-12.5 32.8-12.5 45.3 0l243.6 225.8c6.3 6.2 9.9 14.8 9.9 24z'},
            {name:'magnifying-glass', path:'M416 208c0 45.9-14.9 88.3-40 122.7L502.6 457.4c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0L330.7 376c-34.4 25.2-76.8 40-122.7 40C93.1 416 0 322.9 0 208S93.1 0 208 0s208 93.1 208 208zM208 352a144 144 0 1 0 0-288 144 144 0 1 0 0 288z'},
            {name:'envelope', path:'M48 64C21.5 64 0 85.5 0 112c0 15.1 7.1 29.3 19.2 38.4L236.8 313.6c11.4 8.5 27 8.5 38.4 0L492.8 150.4c12.1-9.1 19.2-23.3 19.2-38.4c0-26.5-21.5-45-48-45H48zM0 176V384c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V176L294.4 339.2c-22.8 17.1-54 17.1-76.8 0L0 176z'},
            {name:'star', path:'M316.9 18C311.6 7 300.4 0 288.1 0s-23.4 7-28.8 18L195 130.3 67.4 148.9c-12.2 1.8-22.3 10.3-26.2 21.9s-.4 24.3 8.5 33L142.4 294l-21.9 127.1c-2.1 12.1 2.9 24.3 13 31.7s23.7C157 448.2 168.4 441.2 179.3 435L288 377.8l108.7 57.1c10.8 5.7 23.3 5.4 33.8-1s15.1-19.6 13-31.7L421.6 294 514.3 203.8c8.9-8.7 12.4-21.4 8.5-33s-14-20.1-26.2-21.9L371.1 130.3 316.9 18z'},
            {name:'check', path:'M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z'}
        ]));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Icon Gallery</title><style>
            body{font-family:sans-serif;background:#0d0d0f;color:#e4e4e7;padding:30px;text-align:center;}
            h1{color:#ff9f43;}
            .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:15px;max-width:1000px;margin:30px auto;}
            .card{background:#141416;padding:20px;border-radius:12px;border:1px solid #27272a;}
            .card svg{width:50px;height:50px;fill:#ff9f43;margin-bottom:10px;}
        </style></head><body>
            <h1>FontAwesome Standalone Gallery 🚀</h1>
            <div class="grid" id="gallery"></div>
            <script>
                fetch('/api/list-ikon').then(r=>r.json()).then(data=>{
                    document.getElementById('gallery').innerHTML = data.map(i=>\`
                        <div class="card">
                            <svg viewBox="0 0 512 512"><path d="\${i.path}" /></svg>
                            <div>\${i.name}</div>
                        </div>
                    \`).join('');
                });
            </script>
        </body></html>`);
    }
});
server.listen(3000, () => console.log('Sukses Mang! Buka http://localhost:3000'));
