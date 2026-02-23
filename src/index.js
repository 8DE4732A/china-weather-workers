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
  const folderId = await getOrCreateFolder(accessToken, "china_weather");
  let uploaded = 0;
  for (const radar of radars) {
    const ft = radar.ft;
    if (!ft) {
      continue;
    }

    const imgUrl =
      "https://pi.weather.com.cn/i/product/pic/l/sevp_nsmc_" +
      radar.fn +
      "_lno_py_" +
      ft +
      ".jpg";

    const alreadyProcessed = await isProcessed(env.DB, ft);
    if (alreadyProcessed) {
      continue;
    }

    if (uploaded >= 20) {
      console.log("Reached upload limit, will continue next run.");
      break;
    }

    try {
      await uploadImageToDrive({
        accessToken,
        folderId,
        fileName: `${ft}.jpg`,
        imgUrl,
      });
      await markProcessed(env.DB, { ft, fn: radar.fn, imgUrl });
      uploaded += 1;
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
  const resp = await fetch("https://ogd.richardxiong.com/api/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: env.GDRIVE_REFRESH_TOKEN }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Token error: ${resp.status} ${errorText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function getOrCreateFolder(accessToken, folderName) {
  const query = encodeURIComponent(
    `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const searchResp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!searchResp.ok) {
    const errorText = await searchResp.text();
    throw new Error(`Folder search failed: ${searchResp.status} ${errorText}`);
  }

  const searchData = await searchResp.json();
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  const createResp = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });

  if (!createResp.ok) {
    const errorText = await createResp.text();
    throw new Error(`Folder create failed: ${createResp.status} ${errorText}`);
  }

  const folder = await createResp.json();
  return folder.id;
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
      "SELECT ft, img_url, created_at FROM (SELECT ft, img_url, created_at FROM processed ORDER BY ft DESC LIMIT ?) ORDER BY ft ASC",
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
