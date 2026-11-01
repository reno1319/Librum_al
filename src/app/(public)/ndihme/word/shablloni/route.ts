import { buildWordTemplate, WORD_TEMPLATE_CONTENT_TYPE, WORD_TEMPLATE_FILENAME } from "@/lib/word-template";

// BD6: the Librum Word template, built from word-template.ts on each
// request (a few KB, same bytes every time). Public like the guide page
// that links it; behind the Under construction lock like every page.
export async function GET() {
  const bytes = await buildWordTemplate();
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": WORD_TEMPLATE_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${WORD_TEMPLATE_FILENAME}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
