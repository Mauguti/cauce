import factoryPreset from "../../design-export/tailwind.preset.js";

/** @type {import('tailwindcss').Config} */
export default {
  presets: [factoryPreset],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
};
