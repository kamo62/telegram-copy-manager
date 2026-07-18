import { CartesianCanvas } from "./cartesian-canvas";
import { type CartesianChartProps, CartesianRoot } from "./cartesian-root";

type Row = Record<string, unknown>;

/** Composable dither **area** chart. Compose `<Area>`, `<Grid>`, axes, … inside. */
export function AreaChart<TData extends Row>(props: CartesianChartProps<TData>) {
  return <CartesianRoot chartType="area" Canvas={CartesianCanvas} {...props} />;
}
