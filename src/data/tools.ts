export type ToolIcon = 'circle' | 'vector' | 'collage' | 'json' | 'jwt' | 'encode' | 'clock' | 'loan';

export interface Tool {
  slug: string;
  name: string;
  blurb: string;
  category: 'Media' | 'Developer';
  icon: ToolIcon;
  live: boolean;
}

// Ship order. Flip `live` and add src/pages/tools/<slug>.astro when a tool ships.
export const tools: Tool[] = [
  { slug: 'circle-crop', name: 'Circle crop', blurb: 'Crop to a circle or oval, export a transparent PNG.', category: 'Media', icon: 'circle', live: true },
  { slug: 'image-to-svg', name: 'Image to SVG', blurb: 'Trace photos and drawings into clean vectors.', category: 'Media', icon: 'vector', live: true },
  { slug: 'collage', name: 'Collage maker', blurb: 'Arrange photos in templates, or draw your own.', category: 'Media', icon: 'collage', live: true },
  { slug: 'json', name: 'JSON tools', blurb: 'Format, validate, minify and explore as a tree.', category: 'Developer', icon: 'json', live: true },
  { slug: 'jwt', name: 'JWT decoder', blurb: 'See a token’s header, payload and expiry.', category: 'Developer', icon: 'jwt', live: true },
  { slug: 'encode', name: 'Encode & decode', blurb: 'Base64, URL and HTML entities, both ways.', category: 'Developer', icon: 'encode', live: true },
  { slug: 'timestamp', name: 'Timestamp converter', blurb: 'Unix time to local and UTC, and back.', category: 'Developer', icon: 'clock', live: true },
  { slug: 'loan', name: 'Loan calculator', blurb: 'Monthly payments and an amortisation table.', category: 'Developer', icon: 'loan', live: true },
];
