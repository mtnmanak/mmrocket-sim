/** Search-engine discovery, emitted with the date of this build. */
export const SITEMAP_NAVIGATION = /\/sitemap\.xml(?:\?|$)/;

export function sitemapPlugin() {
  return {
    name: 'sitemap',
    apply: 'build',
    generateBundle() {
      const lastmod = new Date().toISOString().slice(0, 10);
      const urls = ['https://mmrsim.mountainmanrockets.com/', 'https://mmrsim.mountainmanrockets.com/releases/'];
      const source = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + urls.map(url => `  <url><loc>${url}</loc><lastmod>${lastmod}</lastmod></url>\n`).join('')
        + '</urlset>\n';
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source });
    },
  };
}
