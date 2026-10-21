# SC Hauling Companion

Web planner for Star Citizen cargo / hauling contracts — multi-mission routes under ship capacity.

Inspired by [SuperCargo](https://github.com/AquatikJustice/SuperCargo) (capacitated pickup-and-delivery routing, multi-pickup OCR) and [sc-hauling.tools](https://sc-hauling.tools/) (mission types, run config, distance in Gm).

## Features

- **Live APIs:** ships & commodities from [UEX](https://api.uexcorp.uk/2.0/); locations from UEX terminals + scunpacked coords; mission name catalog from haul rank/type patterns
- **Mission types:** Direct, Multiple Pick Up, Multiple Drop Off, Free Shopping
- **Per-mission max crate size** (spread unknown per-stop SCU with that mission’s crate size)
- **No skipped stops:** every mission/location is routed; trips split only when total SCU exceeds hold
- **OCR / paste:** screenshot drop, Ctrl+V, or paste contract text (browser-local Tesseract)

## Run

```bash
npm install
npm run dev
```

## Credits

- Routing approach adapted from ideas in SuperCargo (`src/shared/route.ts`)
- UX patterns (mission types, capacity, Gm summary) from sc-hauling.tools
- Coordinates from [UEXcorp](https://uexcorp.space) snapshots bundled in SuperCargo

Unofficial Star Citizen community tool — not affiliated with CIG/RSI.
