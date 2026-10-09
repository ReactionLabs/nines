import journalSnapshot from "@/data/journal.json";

export const dynamic = "force-dynamic";

const GITHUB_URL =
  "https://api.github.com/repos/ReactionLabs/tyck-trade/contents/data/journal.json";

export async function GET() {
  const token = process.env.GITHUB_TOKEN;

  if (token) {
    try {
      const res = await fetch(GITHUB_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw",
        },
        next: { revalidate: 60 },
      });
      if (res.ok) {
        return Response.json(await res.json());
      }
    } catch {
      // fall through to snapshot
    }
  }

  return Response.json(journalSnapshot ?? {});
}
