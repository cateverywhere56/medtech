// scripts/generate-article.js
// 1 article original par jour (FR) — IA / high-tech / objets connectés / smartphones / comparatifs
// Rédaction via OpenAI Responses API (Markdown), image via Openverse (fallback CC).

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import slugify from "slugify";
import matter from "gray-matter";
import OpenAI from "openai";

/* --- CONFIG --- */
const MODEL = process.env.OPENAI_MODEL || "gpt-4o"; // définis OPENAI_MODEL si tu veux
const OUT_DIR = path.join("src", "content", "articles");
const OPENVERSE_PAGE_SIZE = 12;

/** Flux FR/tech pour s’inspirer du sujet du jour (on ne copie pas) */
const FEEDS_FR = [
  { name: "Frandroid",        url: "https://www.frandroid.com/feed" },
  { name: "Les Numériques",   url: "https://www.lesnumeriques.com/rss.xml" },
  { name: "01net (Actus)",    url: "https://www.01net.com/actualites/feed/" },
  { name: "Journal du Geek",  url: "https://www.journaldugeek.com/rss/" },
  { name: "Numerama",         url: "https://www.numerama.com/feed/" },
  { name: "PhonAndroid",      url: "https://www.phonandroid.com/feed" },
  { name: "Tom’s Guide FR",   url: "https://www.tomsguide.fr/feed/" },
];

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* --- Utils --- */
function todayYMD() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function normalizeUrl(u) {
  try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase(); }
  catch { return String(u).toLowerCase(); }
}
function yaml(frontmatter) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  return Object.entries(frontmatter).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.map(x=>`"${esc(x)}"`).join(", ")}]` : `${k}: "${esc(v)}"`
  ).join("\n") + "\n";
}

/* --- Feeds → idée de sujet --- */
async function fetchFeed(url) {
  const res = await fetch(url, { headers: { "User-Agent": "article-gen (+github)" } });
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false });
  const channel = parsed?.rss?.channel || parsed?.feed;
  const raw = channel?.item || channel?.entry || [];
  return Array.isArray(raw) ? raw : [raw];
}
function cleanText(s=""){ return String(s).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(); }

async function getInspiration() {
  for (const f of FEEDS_FR) {
    try {
      const items = (await fetchFeed(f.url))
        .map((e) => ({
          title: cleanText(e.title),
          link: e.link?.href || e.link,
          summary: cleanText(e.description || e.summary || e.content || ""),
          source: f.name,
          dateISO: e.pubDate || e.published || e.updated || new Date().toISOString(),
        }))
        .filter((x) => x.title && x.link);
      if (items.length) {
        // item le plus récent
        items.sort((a,b)=>new Date(b.dateISO)-new Date(a.dateISO));
        return items[0];
      }
    } catch (e) {
      console.error("Feed error:", f.name, f.url, String(e).slice(0,120));
    }
  }
  // fallback si tous les flux tombent
  return {
    title: "Quel smartphone milieu de gamme choisir en 2025 ?",
    link: "",
    summary: "Guide d’achat : points clés, fiches techniques à privilégier, autonomie, photo, suivi logiciel.",
    source: "Sujet générique",
    dateISO: new Date().toISOString(),
  };
}

/* --- Image Openverse (filtrée) --- */
const BAD_WORDS = ["meme","poster","flyer","banner","logo","icon","clipart","wallpaper","quote","typography","infographic","chart","graph","diagram","vector","illustration","ai generated","prompt","template"];
const PREFERRED_PROVIDERS = new Set(["wikimedia","flickr"]);
function looksBad(str="", tags=[]){
  const s = (str||"").toLowerCase();
  if (BAD_WORDS.some(w=>s.includes(w))) return true;
  const tagText = (tags||[]).map(t=>(t?.name||t?.title||t||"").toString().toLowerCase()).join(" ");
  if (BAD_WORDS.some(w=>tagText.includes(w))) return true;
  return false;
}
async function findImageOpenverse(query, avoidFP=new Set()){
  const variants = [query, "high-tech", "objets connectés", "smartphone"].filter(Boolean);
  for (const q of variants) {
    try {
      const api = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial&page_size=${OPENVERSE_PAGE_SIZE}`;
      const res = await fetch(api, { headers: { "User-Agent": "article-gen (+github)" } });
      if (!res.ok) continue;
      const data = await res.json();
      let results = (data.results||[]).filter(it=>{
        const url = it.url || it.thumbnail; if(!url) return false;
        if (looksBad(it.title, it.tags)) return false;
        if (it.category && String(it.category).toLowerCase() !== "photograph") return false;
        if (it.width && it.height && (it.width < 800 || it.height < 500)) return false;
        const fp = normalizeUrl(url); if (avoidFP.has(fp)) return false;
        return true;
      });
      results.sort((a,b)=>{
        const ap = PREFERRED_PROVIDERS.has(String(a.provider).toLowerCase()) ? 0 : 1;
        const bp = PREFERRED_PROVIDERS.has(String(b.provider).toLowerCase()) ? 0 : 1;
        return ap - bp;
      });
      const it = results[0];
      if (it) {
        return {
          url: it.url || it.thumbnail,
          credit: `${it.creator ? it.creator : "Auteur inconnu"} — ${(it.license || "CC").toUpperCase()} via Openverse`,
          source: it.foreign_landing_url || it.url
        };
      }
    } catch { /* try next */ }
  }
  return null;
}

/* --- Rédaction via OpenAI --- */
async function writeArticleFR(topic) {
  const system = `Tu es journaliste tech francophone. Écris un article ORIGINAL et factuel (600–900 mots) en Markdown, sur le thème high-tech/IA/objets connectés/smartphones. Structure:
# Titre accrocheur (H1)
Intro (3–4 phrases)
## Points clés
• 4–6 puces concises
## Décryptage
(paragraphes clairs)
## Comparatif / “Lequel choisir ?” (si pertinent)
• fais une mini-table en Markdown si cohérent
## FAQ
Q/R (2–3 items)
Ton neutre, concret, pas de chiffres inventés. Pas de HTML, pas d'emojis.`;

  const user = `Sujet à traiter (inspiration, NE PAS copier) :
- Titre source: ${topic.title}
- Résumé source: ${topic.summary || "(non fourni)"} 
- Lien éventuel: ${topic.link || "(n/a)"}

Contraintes:
- Français uniquement.
- Adapte le sujet si nécessaire pour rester intemporel et utile (guide, comparatif, analyse).
- N'invente pas de spécifications ou de benchmarks précis si tu n'es pas sûr : reste qualitatif.`;

  // Responses API — sortie en texte Markdown
  const resp = await client.responses.create({
    model: MODEL,
    instructions: system,
    input: user,
  }); // https://www.npmjs.com/package/openai (Responses API, output_text)

  const md = (resp.output_text || "").trim();
  if (!md) throw new Error("Réponse vide du modèle.");
  return md;
}

/* --- Extraire le H1 comme titre --- */
function extractTitle(markdown) {
  const m = markdown.match(/^#\s+(.+)\s*$/m);
  return m ? m[1].trim() : null;
}

/* --- MAIN --- */
async function main(){
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const inspiration = await getInspiration();
  const draft = await writeArticleFR(inspiration);
  const title = extractTitle(draft) || inspiration.title || "Article high-tech";
  const date = new Date();
  const slug = `${todayYMD()}-${slugify(title, { lower: true, strict: true })}`;

  const target = path.join(OUT_DIR, `${slug}.md`);
  if (fs.existsSync(target)) {
    console.log("⏭️  Déjà présent aujourd'hui:", target);
    return;
  }

  // Éviter de réutiliser une image déjà utilisée par d’anciens articles
  const existing = new Set();
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!f.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(OUT_DIR, f), "utf-8");
    const { data } = matter(raw);
    if (data?.imageUrl) existing.add(normalizeUrl(String(data.imageUrl)));
  }

  const img = await findImageOpenverse(title, existing);

  const frontmatter = {
    title,
    date: date.toISOString(),
    publishedDate: date.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" }),
    summary: "Article original sur le thème high-tech / IA / objets connectés / smartphones.",
    author: "ChatGPT-5 (IA)",
    model: MODEL,
    tags: ["Article", "High-Tech", "IA"],
    permalink: `/articles/${slug}`,
    sourceIdeas: inspiration.link ? [inspiration.link] : [],
    imageUrl: img?.url || "",
    imageCredit: img ? `${img.credit}${img.source ? " — " + img.source : ""}` : ""
  };

  const body =
    (img?.url ? `![${title}](${img.url})\n\n${frontmatter.imageCredit ? `*Crédit image : ${frontmatter.imageCredit}*\n\n` : ""}` : "") +
    draft + "\n";

  fs.writeFileSync(target, `---\n${yaml(frontmatter)}---\n\n${body}`, "utf-8");
  console.log(`✅ Article généré: ${target}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
