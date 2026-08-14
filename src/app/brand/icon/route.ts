import { serveBrandAsset } from "../serve";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return serveBrandAsset("icon");
}
