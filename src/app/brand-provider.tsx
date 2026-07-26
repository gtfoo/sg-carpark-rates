"use client";

import { createContext, useContext } from "react";
import type { Brand } from "@/lib/brand";

const BrandContext = createContext<Brand | null>(null);

export function BrandProvider({
  brand,
  children,
}: Readonly<{ brand: Brand; children: React.ReactNode }>) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  const brand = useContext(BrandContext);
  if (!brand) throw new Error("useBrand must be used inside BrandProvider");
  return brand;
}