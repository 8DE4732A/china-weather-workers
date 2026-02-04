const JSONP_URL = "https://d1.weather.com.cn/satellite2015/JC_YT_DL_WXZXCSYT_4B.html";
const REFERER = "http://www.weather.com.cn/satellite/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.109 Safari/537.36";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
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

    const alreadyProcessed = await isProcessed(env.DB, ft);
    if (alreadyProcessed) {
      continue;
    }

    const imgUrl =
      "https://pi.weather.com.cn/i/product/pic/m/sevp_nsmc_" +
      radar.fn +
      "_lno_py_" +
      ft +
      ".jpg";

    try {
      await uploadImageToDrive({
        accessToken,
        folderId: env.GDRIVE_FOLDER_ID,
        fileName: `${ft}.jpg`,
        imgUrl,
      });
      await markProcessed(env.DB, ft);
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

async function markProcessed(db, ft) {
  await db
    .prepare("INSERT OR IGNORE INTO processed (ft, created_at) VALUES (?, ?)")
    .bind(ft, new Date().toISOString())
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
