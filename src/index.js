const JSONP_URL = "https://d1.weather.com.cn/satellite2015/JC_YT_DL_WXZXCSYT_4B.html";
const REFERER = "http://www.weather.com.cn/satellite/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.109 Safari/537.36";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return servePage();
    }
    if (url.pathname === "/api/list") {
      return listFrames(env.DB, url);
    }
    if (url.pathname === "/img") {
      return proxyImage(url, ctx);
    }
    return new Response("Not Found", { status: 404 });
  },
};

async function handleScheduled(env) {
  const radars = await fetchRadarList();
  if (!radars.length) {
    console.log("No radars found.");
    return;
  }

  const accessToken = await getAccessToken(env);
  for (const radar of radars) {
    const ft = radar.ft;
    if (!ft) {
      continue;
    }

    const imgUrl =
      "https://pi.weather.com.cn/i/product/pic/m/sevp_nsmc_" +
      radar.fn +
      "_lno_py_" +
      ft +
      ".jpg";

    const alreadyProcessed = await isProcessed(env.DB, ft);
    if (alreadyProcessed) {
      continue;
    }

    try {
      await uploadImageToDrive({
        accessToken,
        folderId: env.GDRIVE_FOLDER_ID,
        fileName: `${ft}.jpg`,
        imgUrl,
      });
      await markProcessed(env.DB, { ft, fn: radar.fn, imgUrl });
      console.log(`Uploaded ${ft}.jpg`);
    } catch (err) {
      console.log(`Failed ${ft}.jpg: ${err?.message || err}`);
    }
  }
}

async function fetchRadarList() {
  const ts = Date.now();
  const url = `${JSONP_URL}?jsoncallback=readSatellite&callback=jQuery18208455971171376718_${ts}&_=${ts}`;
  const resp = await fetch(url, {
    headers: {
      Referer: REFERER,
      "User-Agent": USER_AGENT,
    },
  });

  if (!resp.ok) {
    throw new Error(`Fetch JSONP failed: ${resp.status}`);
  }

  const text = await resp.text();
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start === -1 || end === -1) {
    throw new Error("Unexpected JSONP format");
  }

  const jsonText = text.slice(start + 1, end).replace(/'/g, '"');
  const payload = JSON.parse(jsonText);
  if (!payload.radars) {
    return [];
  }

  return payload.radars;
}

async function isProcessed(db, ft) {
  const result = await db
    .prepare("SELECT 1 FROM processed WHERE ft = ? LIMIT 1")
    .bind(ft)
    .first();
  return !!result;
}

async function markProcessed(db, { ft, fn, imgUrl }) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO processed (ft, fn, img_url, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(ft, fn, imgUrl, new Date().toISOString())
    .run();
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: "RS256", typ: "JWT" };
  const jwtClaim = {
    iss: env.GDRIVE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now - 5,
  };

  const unsignedToken = `${base64UrlEncode(JSON.stringify(jwtHeader))}.${base64UrlEncode(
    JSON.stringify(jwtClaim),
  )}`;

  const signature = await signJwt(unsignedToken, env.GDRIVE_PRIVATE_KEY);
  const jwt = `${unsignedToken}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Token error: ${resp.status} ${errorText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function signJwt(unsignedToken, privateKey) {
  const pkcs8 = privateKey.replace(/\\n/g, "\n");
  const binaryKey = pemToArrayBuffer(pkcs8);

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  return base64UrlEncode(signature);
}

function pemToArrayBuffer(pem) {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s+/g, "");
  const binary = atob(pemContents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlEncode(value) {
  let bytes;
  if (typeof value === "string") {
    bytes = new TextEncoder().encode(value);
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (value instanceof Uint8Array) {
    bytes = value;
  } else {
    throw new Error("Unsupported base64url input");
  }

  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function uploadImageToDrive({ accessToken, folderId, fileName, imgUrl }) {
  const imgResp = await fetch(imgUrl, {
    headers: {
      Referer: REFERER,
      "User-Agent": USER_AGENT,
    },
  });

  if (!imgResp.ok) {
    throw new Error(`Image fetch failed: ${imgResp.status}`);
  }

  const imgBuffer = await imgResp.arrayBuffer();

  const metadata = {
    name: fileName,
    parents: [folderId],
  };

  const boundary = "boundary_" + crypto.randomUUID();
  const delimiter = `--${boundary}`;
  const closeDelimiter = `--${boundary}--`;

  const bodyParts = [
    `${delimiter}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
      metadata,
    )}\r\n`,
    `${delimiter}\r\nContent-Type: image/jpeg\r\n\r\n`,
  ];

  const encoder = new TextEncoder();
  const metadataPart = encoder.encode(bodyParts[0]);
  const fileHeaderPart = encoder.encode(bodyParts[1]);
  const closePart = encoder.encode(`\r\n${closeDelimiter}`);

  const combined = new Uint8Array(
    metadataPart.length + fileHeaderPart.length + imgBuffer.byteLength + closePart.length,
  );
  combined.set(metadataPart, 0);
  combined.set(fileHeaderPart, metadataPart.length);
  combined.set(new Uint8Array(imgBuffer), metadataPart.length + fileHeaderPart.length);
  combined.set(closePart, metadataPart.length + fileHeaderPart.length + imgBuffer.byteLength);

  const uploadResp = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: combined,
    },
  );

  if (!uploadResp.ok) {
    const errorText = await uploadResp.text();
    throw new Error(`Drive upload failed: ${uploadResp.status} ${errorText}`);
  }
}

async function listFrames(db, url) {
  const limitParam = Number(url.searchParams.get("limit") || "240");
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), 1000)
    : 240;

  const rows = await db
    .prepare(
      "SELECT ft, img_url, created_at FROM processed ORDER BY ft DESC LIMIT ?",
    )
    .bind(limit)
    .all();

  return new Response(JSON.stringify(rows.results || []), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function proxyImage(url, ctx) {
  const imgUrl = url.searchParams.get("url");
  if (!imgUrl) {
    return new Response("Missing url", { status: 400 });
  }

  const target = new URL(imgUrl);
  if (target.hostname !== "pi.weather.com.cn") {
    return new Response("Forbidden", { status: 403 });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const resp = await fetch(target.toString(), {
    headers: {
      Referer: REFERER,
      "User-Agent": USER_AGENT,
    },
  });

  if (!resp.ok) {
    return new Response(`Image fetch failed: ${resp.status}`, {
      status: resp.status,
    });
  }

  const out = new Response(resp.body, resp);
  out.headers.set("Cache-Control", "public, max-age=86400");
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

function servePage() {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>云图播放</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: \"Noto Serif SC\", \"PingFang SC\", serif; background: #0b0f14; color: #e6eef6; }
      .wrap { max-width: 960px; margin: 0 auto; padding: 24px; }
      h1 { font-size: 24px; margin: 0 0 12px; }
      .player { background: #121826; border-radius: 12px; padding: 12px; }
      img { width: 100%; height: auto; display: block; border-radius: 8px; }
      .meta { display: flex; gap: 12px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
      .meta span { opacity: 0.8; }
      button { background: #2f9e44; color: #fff; border: 0; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
      button.secondary { background: #2b3648; }
      input[type=\"range\"] { width: 140px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>卫星云图播放</h1>
      <div class="player">
        <img id="frame" alt="云图" />
        <div class="meta">
          <button id="toggle">暂停</button>
          <button id="reload" class="secondary">刷新列表</button>
          <label>间隔 <input id="speed" type="range" min="200" max="3000" step="100" value="1000" /></label>
          <span id="status">加载中…</span>
        </div>
      </div>
    </div>
    <script>
      const frame = document.getElementById('frame');
      const status = document.getElementById('status');
      const toggle = document.getElementById('toggle');
      const reloadBtn = document.getElementById('reload');
      const speed = document.getElementById('speed');
      let list = [];
      let idx = 0;
      let timer = null;

      function start() {
        stop();
        timer = setInterval(nextFrame, Number(speed.value));
        toggle.textContent = '暂停';
      }
      function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        toggle.textContent = '播放';
      }
      function nextFrame() {
        if (!list.length) return;
        const item = list[idx];
        const imgUrl = '/img?url=' + encodeURIComponent(item.img_url);
        frame.src = imgUrl;
        status.textContent = item.ft;
        idx = (idx + 1) % list.length;
      }
      async function loadList() {
        status.textContent = '加载中…';
        const resp = await fetch('/api/list');
        list = await resp.json();
        idx = 0;
        if (list.length) {
          nextFrame();
          start();
        } else {
          status.textContent = '暂无数据';
        }
      }
      toggle.addEventListener('click', () => timer ? stop() : start());
      reloadBtn.addEventListener('click', loadList);
      speed.addEventListener('change', () => { if (timer) start(); });
      loadList();
    </script>
  </body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
