/**
 * air — map + data-visualization component library.
 *
 * Everything here is presentational and takes data as props, so the four UI
 * agents can compose it freely. See `README.md` for the full prop catalogue.
 *
 * Three rules the whole library obeys:
 *   1. Every colour comes from a semantic token or a ramp token in `tokens.css`,
 *      read from CSS custom properties at runtime — so deck.gl layers, SVG charts
 *      and canvas particles all follow the role skin with no per-role code.
 *   2. Severity, kind and identity are never carried by colour alone.
 *   3. `prefers-reduced-motion` freezes every animation at a legible pose rather
 *      than removing the information.
 */

// ── the token bridge ───────────────────────────────────────────────────────
export { useTheme, useDocumentTheme, readTheme, parseColor, withAlpha, rgbaCss, mix, luminance } from './lib/theme';
export type { Theme, MapSkin, RGBA, TokenName } from './lib/theme';

// ── scales & helpers ───────────────────────────────────────────────────────
export {
  makeColorScale, robustDomain, persistenceAlpha, persistenceWidth,
  persistenceRung, noDataColor,
} from './lib/scales';
export type { ColorScale, RampName, ScaleMode } from './lib/scales';
export { niceStep, niceCeil, niceTicks, SEVERITY_GLYPH, METRIC_HELP, CONCERN_LABEL, CONCERN_EMOJI, ALERT_KIND_LABEL, ALERT_KIND_CODE } from './lib/vizmeta';
export {
  haversine, bearingBetween, destination, circleRing, wedge, toPolygons,
  geometryPositions, alongPath, pathMetrics, metersPerPixel, fitZoom,
  bboxOfPositions, bboxCenter, expandBBox, bboxRing, lerpPosition, pointInRing,
} from './lib/geo';
export { usePhase, usePulse, useNow, useReducedMotion, prefersReducedMotion, useFleetAnimation } from './lib/anim';
export type { AnimatedFleetPosition } from './lib/anim';
export { useSize } from './lib/useSize';
export type { Size } from './lib/useSize';
export { GLYPH, icon, monitorGlyph, emissionGlyph, concernGlyph } from './lib/glyphs';
export type { GlyphName, IconSpec } from './lib/glyphs';

// ── the map ────────────────────────────────────────────────────────────────
export { BaseMap, MapOverlay, resolveBackend } from './map/BaseMap';
export type { BaseMapProps, BasemapBackend, OverlayPlace } from './map/BaseMap';
export { MapContext, useMapContext, DEFAULT_VIEW } from './map/MapContext';
export type { MapView, MapContextValue } from './map/MapContext';
export { BASE_STYLE_URL, skinPalette, applyMapLibreSkin, googleMapStyles } from './map/styles/mapStyles';
export type { SkinPalette, GoogleStyleRule } from './map/styles/mapStyles';

// ── layers (factory functions, not components — call them in `layers=[]`) ──
export { SegmentLayer, SegmentHighlightLayer, measureDomain, segmentDomain, segmentTooltipRows } from './map/layers/SegmentLayer';
export type { SegmentLayerProps, SegmentFeature, DualEncoding } from './map/layers/SegmentLayer';
export { MonitorLayer, monitorExceeds } from './map/layers/MonitorLayer';
export type { MonitorLayerProps } from './map/layers/MonitorLayer';
export { SiteLayer, pickedSite } from './map/layers/SiteLayer';
export type { SiteLayerProps } from './map/layers/SiteLayer';
export { ConcernLayer, concernStatusToken } from './map/layers/ConcernLayer';
export type { ConcernLayerProps } from './map/layers/ConcernLayer';
export { FleetLayer } from './map/layers/FleetLayer';
export type { FleetLayerProps } from './map/layers/FleetLayer';
export { BEYOND_ENVELOPE_NOTE, DispersionLayer, hasBeyondEnvelope } from './map/layers/WindLayer';
export { SoftPlumeLayer } from './map/layers/SoftPlumeLayer';
export type { SoftPlumeLayerProps } from './map/layers/SoftPlumeLayer';
export type { DispersionLayerProps } from './map/layers/WindLayer';
export { BoundaryLayer } from './map/layers/BoundaryLayer';
export type { BoundaryLayerProps } from './map/layers/BoundaryLayer';
export { DrivePlanLayer, vehicleColorIndex } from './map/layers/DrivePlanLayer';
export type { DrivePlanLayerProps, DrivePlanMode } from './map/layers/DrivePlanLayer';

// ── wind: particle advection ───────────────────────────────────────────────
export { WindFieldCanvas, mapProjector, makeScopeProjector, viewSignature, windSpeedLegend } from './wind/WindFieldCanvas';
export type { WindFieldCanvasProps } from './wind/WindFieldCanvas';
export { MapWindField } from './wind/MapWindField';
export type { MapWindFieldProps } from './wind/MapWindField';
export { ModelVerificationPanel } from './wind/ModelVerificationPanel';
export type { ModelVerificationPanelProps } from './wind/ModelVerificationPanel';
export { buildFieldIndex, cellConfidence, mercatorProjector, scopeProjector } from './lib/windField';
export type { FieldIndex, FieldSample, Projector } from './lib/windField';

// ── map furniture ──────────────────────────────────────────────────────────
export { MapLegend } from './map/furniture/MapLegend';
export type { MapLegendProps } from './map/furniture/MapLegend';
export { MeasurePicker, MetricPicker } from './map/furniture/Pickers';
export type { MeasurePickerProps, MetricPickerProps, PickerVariant } from './map/furniture/Pickers';
export { MapScale } from './map/furniture/MapScale';
export type { MapScaleProps } from './map/furniture/MapScale';
export { NorthCompass } from './map/furniture/NorthCompass';
export type { NorthCompassProps } from './map/furniture/NorthCompass';
export { MapTooltip, MapPopover } from './map/furniture/MapTooltip';
export type { MapTooltipProps, MapPopoverProps, TooltipRow } from './map/furniture/MapTooltip';
export { LayerToggles } from './map/furniture/LayerToggles';
export type { LayerTogglesProps, LayerToggleItem } from './map/furniture/LayerToggles';
export { SegmentInspector } from './map/furniture/SegmentInspector';
export type { SegmentInspectorProps } from './map/furniture/SegmentInspector';

// ── charts ─────────────────────────────────────────────────────────────────
export { ChartFrame, Legend, ChartTooltip, TableTwin, GridLines, AxisLeft, AxisBottom, EmptyPlot, useChart, useCrosshair } from './charts/primitives';
export type { ChartFrameProps, LegendSeries, TipRow, Margins, HoverState } from './charts/primitives';
export { TimeSeries } from './charts/TimeSeries';
export type { TimeSeriesProps, TimeSeriesSeries, TimeSeriesThreshold, TimeSeriesRange, BandPoint } from './charts/TimeSeries';
export { DiurnalClock } from './charts/DiurnalClock';
export type { DiurnalClockProps, DiurnalBand } from './charts/DiurnalClock';
export { SeasonalStrip, CalendarHeat, ScaleKey } from './charts/SeasonalStrip';
export type { SeasonalStripProps, CalendarHeatProps } from './charts/SeasonalStrip';
export { Sparkline } from './charts/Sparkline';
export type { SparklineProps } from './charts/Sparkline';
export { RiskDial } from './charts/RiskDial';
export type { RiskDialProps } from './charts/RiskDial';
export { Gauge } from './charts/Gauge';
export type { GaugeProps } from './charts/Gauge';
export { Distribution } from './charts/Distribution';
export type { DistributionProps } from './charts/Distribution';
export { AlertTimeline, timelineFromAlerts } from './charts/AlertTimeline';
export type { AlertTimelineProps, TimelineAlert } from './charts/AlertTimeline';
export { WindRose } from './charts/WindRose';
export type { WindRoseProps, RoseBin } from './charts/WindRose';
export { CompassBearing } from './charts/CompassBearing';
export type { CompassBearingProps } from './charts/CompassBearing';
export { RadarScope, contactsFromAlerts } from './charts/RadarScope';
export type { RadarScopeProps, RadarContact, ContactSource } from './charts/RadarScope';

// ── dev-only gallery ───────────────────────────────────────────────────────
export { ComponentGallery } from './Gallery';
