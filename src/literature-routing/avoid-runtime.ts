// Implemented by Codex (LLM agent): types for the pinned libavoid WASM bindings.
// libavoid-js 0.5.0-beta.5 ships declarations for an older binding surface.
type Handle = { delete(): void }
type PointHandle = Handle & { x: number; y: number }
type EnumValue = object
export type RouterHandle = Handle & {
  setRoutingParameter(parameter: EnumValue, value: number): void
  setRoutingOption(option: EnumValue, value: boolean): void
  processTransaction(): void
}
export type ShapeHandle = object
export type ConnectorHandle = {
  displayRoute(): { size(): number; at(index: number): PointHandle }
}
export type AvoidRuntime = {
  Point: new (x: number, y: number) => PointHandle
  Rectangle: new (a: PointHandle, b: PointHandle) => Handle
  ShapeRef: new (router: RouterHandle, rectangle: Handle) => ShapeHandle
  ShapeConnectionPin: new (
    shape: ShapeHandle,
    id: number,
    x: number,
    y: number,
    proportional: boolean,
    offset: number,
    directions: number
  ) => { setExclusive(value: boolean): void }
  ConnEnd: new (pointOrShape: PointHandle | ShapeHandle, pin?: number) => Handle
  ConnRef: new (router: RouterHandle, a: Handle, b: Handle) => ConnectorHandle
  Router: new (flags: number) => RouterHandle
  RoutingParameter: {
    shapeBufferDistance: EnumValue
    segmentPenalty: EnumValue
    idealNudgingDistance: EnumValue
  }
  RoutingOption: {
    nudgeSharedPathsWithCommonEndPoint: EnumValue
    nudgeOrthogonalTouchingColinearSegments: EnumValue
  }
}
