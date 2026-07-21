## UX Review — static — 1 surface

### Summary
Broken workflow: a 4-screen wizard for one blood-pressure reading.

### Broken
- [RecordBpWizard] — recording one BP reading (systolic/diastolic/pulse) is split into a **4-step
  wizard** — four screens and four taps for what is a single short form. In a hospital every extra
  screen per vitals entry is **clinician time taken from patient care**. This **should be one form**
  on **one screen**; combine the three inputs and consolidate the review. Layout/a11y are otherwise
  fine. (src/pages/Facility/patient/components/RecordBpWizard.tsx)

### Convention
- none

### Polish
- none
