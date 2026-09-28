// Temporary tool: generate the demo-video voiceover with Workers AI (Deepgram Aura 2).
// Visit /api/voice-demo?key=<KEY> to preview voices and download a WAV.
// Safe to delete this file (and its two routes in worker.js) once the video is done.
import { json } from "./core/util.js";

const KEY = "x09-vo-7f3k9q";
const MODEL = "@cf/deepgram/aura-2-en";

// Each phrase is generated separately and joined with a short silence,
// so the lines can be timed individually in the video.
const PHRASES = [
  "Meet X zero nine.",
  "Your AI co-pilot.",
  "Ask anything.",
  "Plan, write, code, and analyze, in seconds.",
  "Answers stream in instantly.",
  "Fast mode for speed.",
  "Deep mode, for the hard stuff.",
  "Every mission is saved to your account,",
  "on any device.",
  "Plans from twelve dollars a month.",
  "X zero nine.",
  "Launch your mission.",
];

// Script v2: fuller sentences for more natural, professional delivery
const PHRASES_V2 = [
  "Meet X zero nine. Your AI co-pilot.",
  "Ask anything. Plan, write, code, and analyze, in seconds.",
  "Answers stream in instantly. Fast mode, for speed.",
  "And Deep mode, for the hard stuff.",
  "Every mission is saved to your account, on any device.",
  "Plans start at just twelve dollars a month.",
  "X zero nine. Launch your mission.",
];

const VOICES = [
  { id: "athena", label: "Athena", note: "Calm, smooth, professional" },
  { id: "hera", label: "Hera", note: "Warm, smooth, professional" },
  { id: "thalia", label: "Thalia", note: "Clear, confident, energetic" },
  { id: "asteria", label: "Asteria", note: "Polished, knowledgeable" },
  { id: "luna", label: "Luna", note: "Warm, friendly, natural" },
  { id: "helena", label: "Helena", note: "Calm, caring" },
  { id: "pandora", label: "Pandora", note: "British accent, smooth" },
];

const SR = 24000;

async function speak(env, text, speaker) {
  const out = await env.AI.run(MODEL, { text, speaker, encoding: "linear16", container: "none", sample_rate: SR });
  const buf = new Uint8Array(await new Response(out).arrayBuffer());
  // If a WAV header came back anyway, strip it
  if (buf.length > 44 && String.fromCharCode(...buf.slice(0, 4)) === "RIFF") {
    for (let i = 12; i < buf.length - 8; ) {
      const id = String.fromCharCode(...buf.slice(i, i + 4));
      const size = buf[i + 4] | (buf[i + 5] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24);
      if (id === "data") return buf.slice(i + 8, i + 8 + size);
      i += 8 + size;
    }
  }
  return buf;
}

function wav(pcmParts, gapSeconds) {
  const gap = new Uint8Array(Math.round(SR * gapSeconds) * 2);
  const parts = [];
  pcmParts.forEach((p, i) => { if (i) parts.push(gap); parts.push(p); });
  const dataLen = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const str = (o, s) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, dataLen, true);
  let o = 44; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function voiceDemo(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== KEY) return json({ error: "Not found" }, 404);

  if (url.pathname.endsWith("/audio")) {
    const voice = VOICES.find((v) => v.id === url.searchParams.get("voice")) || VOICES[0];
    const pcm = [];
    const script = url.searchParams.get("script") === "2" ? PHRASES_V2 : PHRASES;
    for (const p of script) pcm.push(await speak(env, p, voice.id));
    return new Response(wav(pcm, 0.9), {
      headers: {
        "content-type": "audio/wav",
        "content-disposition": `${url.searchParams.get("dl") ? "attachment" : "inline"}; filename="x09-voiceover-${voice.id}.wav"`,
        "cache-control": "private, max-age=3600",
      },
    });
  }

  const rows = VOICES.map((v) => `
    <div class="v"><div><b>${v.label}</b><span>${v.note}</span></div>
      <audio controls preload="none" src="/api/voice-demo/audio?key=${KEY}&voice=${v.id}"></audio>
      <a href="/api/voice-demo/audio?key=${KEY}&voice=${v.id}&dl=1">Download ${v.label}</a></div>`).join("");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X09 voiceover</title><style>
body{margin:0;background:#000;color:#f2f2f2;font:16px/1.5 system-ui,sans-serif;padding:24px 16px}
h1{font-weight:300;font-size:28px;margin:0 0 6px}p{color:#999;margin:0 0 22px}
.v{border:1px solid #333;border-radius:10px;padding:16px;margin-bottom:14px}
.v b{display:block;font-size:18px}.v span{color:#999;font-size:14px}
audio{width:100%;margin:12px 0 8px}a{display:inline-block;padding:10px 16px;background:#fff;color:#000;border-radius:6px;text-decoration:none;font-weight:600}
</style></head><body><h1>X09 demo voiceover</h1>
<p>Tap play to hear each voice (it takes ~10 seconds to generate the first time). Download the one you like and send it to Claude.</p>
${rows}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
