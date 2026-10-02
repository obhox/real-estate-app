// Single source of truth for public site content: estates, prices, stats,
// contact details and Build/Hold/Grow copy. The client edits here — never
// in components. Empty strings hide their row/note (titleType, rcNumber,
// adviserConfirmHours).

export type SiteEstateImage = { src: string; alt: string; render: boolean };

export type SiteEstate = {
  slug: string;
  name: string;
  area: string;
  landmark: string;
  sizes: string;
  minSize: number;
  maxSize: number;
  from: number;
  status: "Available" | "Pre-sale" | "Sold out";
  titleType?: string;
  paymentPlan?: string;
  images: SiteEstateImage[];
};

export const SITE_ESTATES: SiteEstate[] = [
  {
    slug: "aurum-residence",
    name: "Aurum Residence",
    area: "Katampe Extension",
    landmark: "Abuja",
    sizes: "200–400 sqm",
    minSize: 200,
    maxSize: 400,
    from: 16600000,
    status: "Available",
    images: [
      { src: "/aurum-400-fully-detached.jpeg", alt: "Aurum Residence detached duplex", render: true },
      { src: "/aurum-300-semi-detached.jpeg", alt: "Aurum Residence semi-detached duplex", render: true },
      { src: "/aurum-200-terrace.jpeg", alt: "Aurum Residence terrace duplex", render: true },
    ],
  },
  {
    slug: "belgrove-peninsula",
    name: "Belgrove Peninsula",
    area: "Kabusa-Ketti North",
    landmark: "Abuja",
    sizes: "150–900 sqm",
    minSize: 150,
    maxSize: 900,
    from: 5800000,
    status: "Available",
    titleType: "FCTA-approved title",
    paymentPlan: "Outright, or over 0–3 months",
    images: [
      { src: "/peninsula-350-fully-detached.jpeg", alt: "Belgrove Peninsula detached duplex", render: true },
      { src: "/peninsula-150-terrace.jpeg", alt: "Belgrove Peninsula terrace duplex", render: true },
      { src: "/peninsula-250-semi-detached.jpeg", alt: "Belgrove Peninsula semi-detached duplex", render: true },
    ],
  },
  {
    slug: "sunrise-estate",
    name: "Sunrise Estate, Phase 1",
    area: "Kabusa-Ketti North",
    landmark: "Abuja",
    sizes: "150–800 sqm",
    minSize: 150,
    maxSize: 800,
    from: 7500000,
    status: "Available",
    images: [
      { src: "/sunrise-p1-350-fully-detached-bq.jpg", alt: "Sunrise Phase 1 detached duplex", render: true },
      { src: "/sunrise-p1-150-terrace.jpg", alt: "Sunrise Phase 1 terrace duplex", render: true },
      { src: "/sunrise-p1-500-fully-detached-bq.jpg", alt: "Sunrise Phase 1 duplex with BQ", render: true },
    ],
  },
  {
    slug: "sunrise-estate",
    name: "Sunrise Estate, Phase 2",
    area: "Kabusa-Ketti North",
    landmark: "Abuja",
    sizes: "150–800 sqm",
    minSize: 150,
    maxSize: 800,
    from: 4950000,
    status: "Pre-sale",
    images: [
      { src: "/sunrise-p2-800-apartments.jpg", alt: "Sunrise Phase 2 apartment block", render: true },
      { src: "/sunrise-p2-400-fully-detached-bq.jpg", alt: "Sunrise Phase 2 detached duplex", render: true },
      { src: "/sunrise-p2-250-semi.jpg", alt: "Sunrise Phase 2 semi-detached duplex", render: true },
    ],
  },
  {
    slug: "starlight-estate",
    name: "Starlight Estate",
    area: "Kyami",
    landmark: "Abuja",
    sizes: "150–750 sqm",
    minSize: 150,
    maxSize: 750,
    from: 15000000,
    status: "Available",
    images: [
      { src: "/starlight-200-semi.jpeg", alt: "Starlight Estate semi-detached duplex", render: true },
      { src: "/starlight-150-terrace.jpeg", alt: "Starlight Estate terrace duplex", render: true },
      { src: "/starlight-450-detached.jpeg", alt: "Starlight Estate detached duplex", render: true },
    ],
  },
  {
    slug: "downtown-golf-resort",
    name: "Downtown Golf Resort",
    area: "Kuje",
    landmark: "Abuja",
    sizes: "250–1000 sqm",
    minSize: 250,
    maxSize: 1000,
    from: 2500000,
    status: "Sold out",
    images: [
      { src: "/gallery/downtown-golf-resort/2-bed-semi-detached-250sqm.jpg", alt: "Downtown Golf Resort 2 bedroom semi-detached bungalow render", render: true },
      { src: "/gallery/downtown-golf-resort/3-bed-bungalow-350sqm.jpg", alt: "Downtown Golf Resort 3 bedroom bungalow render", render: true },
      { src: "/gallery/downtown-golf-resort/4-bedroom-bungalow.jpg", alt: "Downtown Golf Resort 4 bedroom bungalow with BQ render", render: true },
      { src: "/gallery/downtown-golf-resort/5-bed-penthouse-550sqm.jpg", alt: "Downtown Golf Resort 5 bedroom penthouse render", render: true },
      { src: "/gallery/downtown-golf-resort/3-bed-block-of-flats-1000sqm.jpg", alt: "Downtown Golf Resort 3 bedroom block of flats render", render: true },
    ],
  },
];

export const HERO_SLIDES: (SiteEstateImage & { caption: string })[] = [
  { src: "/peninsula-900-apartments.jpeg", alt: "Belgrove Peninsula apartments", render: true, caption: "Belgrove Peninsula · Kabusa-Ketti North" },
  { src: "/sunrise-p1-800-apartments.jpg", alt: "Sunrise Estate apartment block", render: true, caption: "Sunrise Estate · Kabusa-Ketti North" },
  { src: "/starlight-750-flats.jpeg", alt: "Starlight Estate flats", render: true, caption: "Starlight Estate · Kyami" },
];

/** Featured gallery. First image is the default main view. */
export const FEATURED_GALLERY: SiteEstateImage[] = [
  { src: "/peninsula-500-fully-detached-bq.jpeg", alt: "Belgrove Peninsula duplex with BQ", render: true },
  { src: "/peninsula-350-fully-detached.jpeg", alt: "Belgrove Peninsula detached duplex", render: true },
  { src: "/peninsula-150-terrace.jpeg", alt: "Belgrove Peninsula terrace duplex", render: true },
  { src: "/peninsula-250-semi-detached.jpeg", alt: "Belgrove Peninsula semi-detached duplex", render: true },
];

export const FEATURED_VIDEO = {
  src: "/belgrove-hero-golden-aerial.mp4",
  label: "Site walk",
};

export const GROUND_VIDEO = {
  src: "/belgrove-hero-golden-aerial.mp4",
};

/** Real site photos only. Captions describe what is actually in the photo. */
export const GROUND_PHOTOS: (SiteEstateImage & { caption: string })[] = [
  {
    src: "/belgrove-inspection-team.jpg",
    alt: "Adviser at a Sunrise Estate client activation",
    render: false,
    caption: "Sunrise Estate · Client activation · Sep 2026",
  },
  {
    src: "/belgrove-team.jpg",
    alt: "Belgrove field team on site",
    render: false,
    caption: "Abuja · Field team · Sep 2026",
  },
];

/** Shared with the cinematic entrance. Rendered as real numbers, never animated. */
export const SITE_STATS = [
  { display: "33,000+", label: "SQM SOLD" },
  { display: "100+", label: "FAMILIES SERVED" },
  { display: "5", label: "ESTATES" },
] as const;

export const SITE_CONTACT = {
  phoneDisplay: "+234 810 376 0063",
  phoneHref: "tel:+2348103760063",
  phones: ["+234 810 376 0063"],
  email: "info@belgrovehomes.com",
  address: "Suite 25, Lebrex Plaza, 47 Ajose Adeogun St, Utako, Abuja",
  whatsapp: "https://wa.me/2348103760063",
  mapEmbed:
    "https://www.google.com/maps?q=Lebrex+Plaza,+47+Ajose+Adeogun+St,+Utako,+Abuja&output=embed",
  /** Hours within which an adviser confirms a visit. Empty hides the note. */
  adviserConfirmHours: "",
  /** CAC registration number. Empty hides the RC part. */
  rcNumber: "",
};

export type MethodStep = {
  id: "build" | "hold" | "grow";
  tab: string;
  kicker: string;
  title: string;
  body: string;
  ideal: string;
};

export const METHOD_STEPS: MethodStep[] = [
  {
    id: "build",
    tab: "Build",
    kicker: "STEP 1 · BUILD",
    title: "The plot for the home you have imagined.",
    body: "We start with your vision, not our inventory, then verify each shortlisted plot and stay with you through foundation.",
    ideal: "Ideal for families ready to build within 0–24 months.",
  },
  {
    id: "hold",
    tab: "Hold",
    kicker: "STEP 2 · HOLD",
    title: "An asset that waits for you.",
    body: "Well-chosen land is patient capital: no tenants, hedged against inflation, appreciating as roads and commerce arrive.",
    ideal: "Ideal for investors building a 3–10 year portfolio.",
  },
  {
    id: "grow",
    tab: "Grow",
    kicker: "STEP 3 · GROW",
    title: "A legacy for your family.",
    body: "A plot bought wisely today becomes a home, an income, or a parcel that multiplies as the neighbourhood matures.",
    ideal: "Ideal for generational wealth on a 10+ year horizon.",
  },
];

export const PLOT_SIZES = [150, 200, 250, 300, 350, 400, 450, 500, 750, 800, 900, 1000];

export const BUDGETS = [
  { value: "any", label: "Any budget" },
  { value: "under10", label: "Under ₦10M" },
  { value: "10to20", label: "₦10M–₦20M" },
  { value: "over20", label: "₦20M+" },
] as const;

export function estateMatchesBudget(from: number, budget: string): boolean {
  if (budget === "under10") return from < 10_000_000;
  if (budget === "10to20") return from >= 10_000_000 && from <= 20_000_000;
  if (budget === "over20") return from > 20_000_000;
  return true;
}

export function formatNaira(n: number): string {
  return "₦" + n.toLocaleString("en-NG");
}
