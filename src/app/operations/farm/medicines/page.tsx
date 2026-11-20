"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmMedicines } from "@/components/farm-medicines";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** A farm's medicine cabinet (MED1-MED10). `?farm=` opens a particular farm. */
function Medicines() {
  const farm = useSearchParams().get("farm");
  return <FarmWorkspace title="Medicines" linkedFarmId={farm}>{(context) => <FarmMedicines {...context} />}</FarmWorkspace>;
}

export default function FarmMedicinesPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <Medicines />
      </Suspense>
    </Page>
  );
}
