// Root: gate on auth, then render the workflow shell. All workflow state lives
// in useWorkflow (backend-driven); this file only wires data into each stage.

import { useAuth } from "./context/AuthContext";
import { useWorkflow } from "./hooks/useWorkflow";
import AuthScreen from "./components/auth/AuthScreen";
import Sidebar from "./components/layout/Sidebar";
import StatsBar from "./components/layout/StatsBar";
import Toast from "./components/layout/Toast";
import UserMenu from "./components/layout/UserMenu";
import IngestStep from "./components/steps/IngestStep";
import MappingStep from "./components/steps/MappingStep";
import CleanRunStep from "./components/steps/CleanRunStep";
import CleanReviewStep from "./components/steps/CleanReviewStep";
import HumanReviewStep from "./components/steps/HumanReviewStep";
import MasterStep from "./components/steps/MasterStep";
import ExtractStep from "./components/steps/ExtractStep";

export default function App() {
  const { user, booting, logout } = useAuth();

  if (booting) {
    return <div className="bootscreen">Loading…</div>;
  }
  if (!user) {
    return <AuthScreen />;
  }
  return <Workspace user={user} logout={logout} />;
}

function Workspace({ user, logout }) {
  const wf = useWorkflow();
  const { step, setStep } = wf;

  return (
    <div className="shell">
      <Sidebar steps={wf.steps} step={step} setStep={setStep} />

      <main className="main">
        <div className="topbar">
          <UserMenu user={user} logout={logout} />
        </div>
        <StatsBar master={wf.master} clean={wf.cleanRows} review={wf.reviewRows} raw={wf.rawRows} dedup={wf.dedupLog} />

        {step === 0 && (
          <IngestStep
            hot={wf.hot}
            setHot={wf.setHot}
            fileRef={wf.fileRef}
            onFile={wf.onFile}
            busy={wf.busy}
            error={wf.ingestError}
            fileName={wf.fileName}
          />
        )}

        {step === 1 && (
          <MappingStep
            fields={wf.fields}
            headers={wf.headers}
            mapping={wf.mapping}
            suggestions={wf.suggestions}
            toggleMap={wf.toggleMap}
            unmapped={wf.unmapped}
            addColumn={wf.addColumn}
            requiredMapped={wf.requiredMapped}
            next={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <CleanRunStep mapping={wf.mapping} fields={wf.fields} rawRows={wf.rawRows} runClean={wf.runClean} busy={wf.busy} />
        )}

        {step === 3 && (
          <CleanReviewStep
            rows={wf.cleanRows}
            fields={wf.fields}
            edit={wf.editClean}
            upload={wf.uploadClean}
            uploaded={wf.cleanUploaded}
            goReview={() => setStep(4)}
            reviewCount={wf.reviewCount}
            busy={wf.busy}
          />
        )}

        {step === 4 && (
          <HumanReviewStep
            rows={wf.reviewRows}
            fields={wf.fields}
            edit={wf.editReview}
            approve={wf.approveReview}
            goMaster={() => setStep(5)}
          />
        )}

        {step === 5 && (
          <MasterStep
            master={wf.master}
            dedup={wf.dedupLog}
            cleanUploaded={wf.cleanUploaded}
            reviewCount={wf.reviewCount}
            fields={wf.fields}
            goExtract={() => setStep(6)}
            resetMaster={wf.resetMaster}
          />
        )}

        {step === 6 && (
          <ExtractStep
            preset={wf.preset}
            setPreset={wf.setPreset}
            presets={wf.presets}
            extractCols={wf.extractCols}
            extraOptions={wf.extraOptions}
            extra={wf.extra}
            toggleExtra={wf.toggleExtra}
            fields={wf.fields}
            master={wf.master}
            extract={wf.extract}
            csv={wf.csv}
          />
        )}
      </main>

      <Toast message={wf.toast} />
    </div>
  );
}
