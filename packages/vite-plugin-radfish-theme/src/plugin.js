/**
 * RADFish Theme Vite Plugin
 *
 * This plugin provides theming capabilities for RADFish applications:
 * - Reads theme colors from SCSS files (themes/<theme-name>/styles/theme.scss)
 * - Exposes config values via import.meta.env.RADFISH_* constants
 * - Injects CSS variables into HTML <head>
 * - Transforms index.html with config values (title, meta tags, favicon)
 * - Writes manifest.json after build via closeBundle
 *
 * Usage:
 *   radFishThemePlugin()                                              // Use default NOAA theme
 *   radFishThemePlugin({ theme: "noaa-theme", name: "My App" })      // With options
 *
 * Theme Structure:
 *   themes/<theme-name>/
 *     assets/              - Theme icons (served in dev, copied on build)
 *     styles/uswds-config.scss (new)  - USWDS token variable overrides (optional, replaces theme.scss extraction)
 *     styles/theme.scss               - CSS variables and component overrides
 */

import fs from "fs";
import path from "path";
import { getCacheDir } from "./utils.js";
import { getDefaultConfig, deepMerge } from "./config.js";
import { loadThemeFiles, normalizeColorValue } from "./scss.js";
import { needsRecompilation, precompileUswds, precompileThemeScss } from "./compile.js";
import { configureServer } from "./server.js";
import { closeBundle } from "./build.js";

/**
 * Main Vite plugin for RADFish theming
 * @param {Object} options - Plugin options (theme, name, shortName, description, etc.)
 */
export function radFishThemePlugin(options = {}) {
  // Merge user options with defaults
  const mergedConfig = deepMerge(getDefaultConfig(), options);
  const themeName = mergedConfig.theme;

  // Internal defaults — derived from theme directory at build time
  mergedConfig.icons = {
    logo: "/icons/logo.png",
    favicon: "/icons/favicon.ico",
    appleTouchIcon: "/icons/icon-512.png",
  };
  mergedConfig.colors = {
    primary: "#0054a4",
    secondary: "#0093d0",
  };
  mergedConfig.pwa = {
    themeColor: "#0054a4",
    backgroundColor: "#ffffff",
  };
  mergedConfig.typography = {
    fontFamily: "Arial Narrow, sans-serif",
  };

  // Shared context object passed between modules
  const ctx = {
    config: null,
    resolvedViteConfig: null,
    themeDir: null,
    themeName,
    base: "/",
  };

  return {
    name: "vite-plugin-radfish-theme",

    // Load config and return define values
    async config(viteConfig) {
      // Determine root directory
      const root = viteConfig.root || process.cwd();

      // Capture Vite base for asset URL prefixing (precompiled CSS bakes URLs in)
      ctx.base = viteConfig.base || "/";

      // Use the pre-merged config
      ctx.config = mergedConfig;

      // Set theme directory based on theme name
      const themeDirPath = path.resolve(root, "themes", themeName);
      if (fs.existsSync(themeDirPath)) {
        ctx.themeDir = themeDirPath;
        console.log("[radfish-theme] Using theme:", themeName);

        // Load theme tokens from uswds-config.scss (new) or theme.scss (legacy)
        const { uswdsTokens, isUswdsConfig } = loadThemeFiles(themeDirPath);

        if (Object.keys(uswdsTokens).length > 0) {
          // Merge USWDS tokens into config colors for CSS variable injection
          ctx.config.colors = deepMerge(ctx.config.colors, uswdsTokens);

          // Auto-map PWA manifest colors from theme tokens
          // Manifest theme color defaults to primary color from USWDS tokens
          // Manifest background defaults to base-lightest from USWDS tokens

          // Set manifest theme color (use primary token, fallback to default)
          if (uswdsTokens.primary || uswdsTokens.themeColorPrimary) {
            // Handle both legacy (primary) and new (themeColorPrimary) naming
            const primaryValue = normalizeColorValue(
              uswdsTokens.themeColorPrimary || uswdsTokens.primary
            );
            if (primaryValue.match(/^#/)) {
              // It's already a hex color, use it directly
              ctx.config.pwa.themeColor = primaryValue;
            } else {
              // It's a token name - use a safe default
              // Most apps use blue for primary, so #0054a4 is a good default
              ctx.config.pwa.themeColor = '#0054a4';
            }
          }

          // Set manifest background color (use base-lightest token, fallback to white)
          const baseLight =
            uswdsTokens.themeColorBaseLightest ||
            uswdsTokens.themeColorBaseLighter ||
            uswdsTokens.baseLightest ||
            uswdsTokens.baseLighter ||
            uswdsTokens.baseLight;

          if (baseLight) {
            const normalizedBg = normalizeColorValue(baseLight);
            if (normalizedBg.match(/^#/)) {
              ctx.config.pwa.backgroundColor = normalizedBg;
            } else {
              // It's a token name, use white as safe default
              ctx.config.pwa.backgroundColor = '#ffffff';
            }
          }

          // Pre-compile USWDS to static CSS (with caching)
          const uswdsConfigPath = path.join(themeDirPath, "styles", "uswds-config.scss");
          const themeFilePath = path.join(themeDirPath, "styles", "theme.scss");
          const tokensPath = isUswdsConfig ? uswdsConfigPath : themeFilePath;
          const cacheDir = getCacheDir(themeName);

          if (needsRecompilation(cacheDir, tokensPath)) {
            precompileUswds(themeDirPath, themeName, uswdsTokens, isUswdsConfig, { base: ctx.base });
          } else {
            console.log("[radfish-theme] Using cached USWDS compilation");
          }

          // Pre-compile theme SCSS file (theme.scss)
          precompileThemeScss(themeDirPath, themeName);

          console.log("[radfish-theme] Loaded theme from:", themeDirPath);
        }
      } else {
        console.warn(
          `[radfish-theme] Theme "${themeName}" not found at ${themeDirPath}. ` +
            `Skipping theme CSS/icon injection. Copy the themes/ directory from the ` +
            `RADFish template (expected themes/${themeName}/) to enable theming.`,
        );
      }

      // Return define values for import.meta.env.RADFISH_*
      // These are available in app code via import.meta.env.RADFISH_<NAME>.
      // RADFISH_APP_NAME and RADFISH_LOGO are used by the default header component.
      // The rest are available for developers to use in their own components, e.g.:
      //   <img src={import.meta.env.RADFISH_FAVICON} />
      //   <span style={{ color: import.meta.env.RADFISH_PRIMARY_COLOR }}>...</span>
      return {
        define: {
          "import.meta.env.RADFISH_APP_NAME": JSON.stringify(ctx.config.name),
          "import.meta.env.RADFISH_SHORT_NAME": JSON.stringify(
            ctx.config.shortName,
          ),
          "import.meta.env.RADFISH_DESCRIPTION": JSON.stringify(
            ctx.config.description,
          ),
          "import.meta.env.RADFISH_LOGO": JSON.stringify(ctx.config.icons.logo),
          "import.meta.env.RADFISH_FAVICON": JSON.stringify(
            ctx.config.icons.favicon,
          ),
          "import.meta.env.RADFISH_PRIMARY_COLOR": JSON.stringify(
            ctx.config.colors.primary,
          ),
          "import.meta.env.RADFISH_SECONDARY_COLOR": JSON.stringify(
            ctx.config.colors.secondary,
          ),
          "import.meta.env.RADFISH_THEME_COLOR": JSON.stringify(
            ctx.config.pwa.themeColor,
          ),
          "import.meta.env.RADFISH_BG_COLOR": JSON.stringify(
            ctx.config.pwa.backgroundColor,
          ),
        },
      };
    },

    // Store resolved config
    configResolved(viteConfig) {
      ctx.resolvedViteConfig = viteConfig;
    },

    // Serve theme assets in dev mode and watch SCSS for changes
    configureServer(server) {
      configureServer(server, ctx);
    },

    // Transform index.html - inject CSS imports, variables, and update meta tags
    transformIndexHtml(html) {
      if (!ctx.config) return html;

      let result = html;

      // Only inject theme CSS + icon links when a theme directory actually
      // resolved. Without one, the plugin never compiles/serves/copies these
      // files, so injecting references to /radfish-theme/*.css and /icons/*
      // would produce 404s in dev and prod. (config() logs a warning telling
      // the developer to add themes/<name>/.)
      if (ctx.themeDir) {
        // Generate CSS variables from all colors in config
        // Convert camelCase keys to kebab-case for CSS variable names
        const colorVariables = Object.entries(ctx.config.colors)
          .map(([key, value]) => {
            const kebabKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();
            return `        --radfish-color-${kebabKey}: ${value};`;
          })
          .join("\n");

        // Inject theme CSS via link tags (all pre-compiled by plugin)
        // This allows developers to not manually include CSS imports in their code
        // Uses /radfish-theme/ path which is served by middleware in dev and copied to dist in build
        const cssImports = `
    <!-- RADFish Theme CSS (auto-injected by plugin) -->
    <link rel="stylesheet" href="/radfish-theme/uswds-precompiled.css">
    <link rel="stylesheet" href="/radfish-theme/theme.css">`;

        // Generate CSS variables from config
        const cssVariables = `
    <style id="radfish-theme-variables">
      :root {
${colorVariables}
        --radfish-font-family: ${ctx.config.typography.fontFamily};
      }
    </style>`;

        result = result
          .replace("</head>", `${cssImports}\n${cssVariables}\n  </head>`)
          .replace(
            /<link rel="icon" type="image\/x-icon" href=".*?" \/>/,
            `<link rel="icon" type="image/x-icon" href="${ctx.config.icons.favicon}" />`,
          )
          .replace(
            /<link rel="apple-touch-icon" href=".*?" \/>/,
            `<link rel="apple-touch-icon" href="${ctx.config.icons.appleTouchIcon}" />`,
          );
      }

      // Title/meta transforms use inline config values (no external files), so
      // they are safe to apply whether or not a theme directory exists.
      return result
        .replace(
          /<title>.*?<\/title>/,
          `<title>${ctx.config.shortName}</title>`,
        )
        .replace(
          /<meta name="theme-color" content=".*?" \/>/,
          `<meta name="theme-color" content="${ctx.config.pwa.themeColor}" />`,
        )
        .replace(
          /<meta name="description" content=".*?" \/>/,
          `<meta name="description" content="${ctx.config.description}" />`,
        );
    },

    // Write manifest.json after build completes
    closeBundle() {
      closeBundle(ctx);
    },
  };
}
