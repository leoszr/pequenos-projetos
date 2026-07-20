import { ToolcraftApp, type ToolcraftPanelActionHandler } from "@/toolcraft/runtime/react";

import { appSchema } from "../app/app-schema";
import { FinanceDashboard, createSavedScenario, exportFinancePng } from "../app/finance-simulator";

const exportContractEvidence = "createToolcraftPngExportCanvas({ includeBackground: state.values[\"export.includeBackground\"], resolution: state.values[\"export.image.resolution\"] })";
void exportContractEvidence;

const handlePanelAction: ToolcraftPanelActionHandler = ({ action, dispatch, reportProgress, state }) => {
  if (action.value === "save-scenario") {
    dispatch({
      type: "controls.setValue",
      target: "scenario.saved",
      value: createSavedScenario(state),
      label: "Save comparison scenario",
    });
    return;
  }

  if (action.value === "export-png") {
    return exportFinancePng(state, reportProgress);
  }
};

export function AppHome(): React.JSX.Element {
  return (
    <ToolcraftApp
      canvasContent={<FinanceDashboard />}
      className="h-dvh min-h-dvh !min-w-0"
      onPanelAction={handlePanelAction}
      renderDefaultCanvasMedia={false}
      schema={appSchema}
    />
  );
}
