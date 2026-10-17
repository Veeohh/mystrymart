// Tells the partner-deck pages roughly where a visitor is (city / region / country),
// using the location Netlify already knows for every request. No IP addresses are stored.
export default async (req, context) => {
  const g = context.geo || {};
  return Response.json(
    { city: g.city || "", region: (g.subdivision && g.subdivision.name) || "", country: (g.country && g.country.name) || "" },
    { headers: { "Cache-Control": "no-store" } }
  );
};
