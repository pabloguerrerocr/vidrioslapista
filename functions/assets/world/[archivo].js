// Cloudflare Pages entrega el archivo entero aunque el navegador pida solo un pedazo (Range).
// Sin respuestas 206, Chrome no deja adelantar el video con el scroll y Safari no lo reproduce,
// así que aquí se recorta el pedazo pedido. Solo corre para /assets/world/* (ver _routes.json).
const tamanos = new Map(); // tamaño de cada archivo por versión (ETag), mientras viva este proceso

async function medir(env, url, res) {
  const dicho = Number(res.headers.get("Content-Length"));
  if (dicho) return dicho;
  // por dentro Pages no siempre dice el tamaño: se cuenta leyendo el archivo una vez
  const clave = url + " " + (res.headers.get("ETag") || "");
  if (!tamanos.has(clave)) {
    const lector = (await env.ASSETS.fetch(url)).body.getReader();
    let n = 0;
    for (let r = await lector.read(); !r.done; r = await lector.read()) n += r.value.byteLength;
    tamanos.set(clave, n);
  }
  return tamanos.get(clave);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") return env.ASSETS.fetch(request);
  const res = await env.ASSETS.fetch(request.url);
  if (res.status !== 200 || !res.body) return res;

  const encabezados = new Headers(res.headers);
  encabezados.set("Accept-Ranges", "bytes");
  const rango = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") || "");
  if (!rango || (rango[1] === "" && rango[2] === "")) return new Response(res.body, { status: 200, headers: encabezados });

  const total = await medir(env, request.url, res);
  let inicio, fin;
  if (rango[1] === "") {
    inicio = Math.max(0, total - Number(rango[2]));
    fin = total - 1;
  } else {
    inicio = Number(rango[1]);
    fin = rango[2] === "" ? total - 1 : Math.min(Number(rango[2]), total - 1);
  }
  if (inicio > fin) {
    await res.body.cancel();
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  }

  const largo = fin - inicio + 1;
  encabezados.set("Content-Range", `bytes ${inicio}-${fin}/${total}`);
  encabezados.delete("Content-Length");
  const { readable, writable } = new FixedLengthStream(largo);
  context.waitUntil((async () => {
    const lector = res.body.getReader(), escritor = writable.getWriter();
    let visto = 0;
    try {
      while (visto <= fin) {
        const { done, value } = await lector.read();
        if (done) break;
        const desde = Math.max(0, inicio - visto), hasta = Math.min(value.byteLength, fin + 1 - visto);
        visto += value.byteLength;
        if (hasta > desde) await escritor.write(value.subarray(desde, hasta));
      }
      await escritor.close();
    } catch {
      // el navegador cortó el pedido (por ejemplo, al adelantar a otra parte del video)
    } finally {
      lector.cancel().catch(() => {});
    }
  })());
  return new Response(readable, { status: 206, headers: encabezados });
}
