#pragma once
#include <windows.h>
#include <credentialprovider.h>

// Fields shown on the FingerUnlock tile.
enum FINGERUNLOCK_FIELD_ID {
    FUFI_LABEL         = 0,   // large text: "FingerUnlock"
    FUFI_SUBMIT_BUTTON = 1,   // the Unlock button
    FUFI_NUM_FIELDS    = 2,
};

// Pairs a field's visibility state with its interactive state.
struct FIELD_STATE_PAIR {
    CREDENTIAL_PROVIDER_FIELD_STATE             cpfs;
    CREDENTIAL_PROVIDER_FIELD_INTERACTIVE_STATE cpfis;
};

// Phase 1 ONLY: the CP reads the account credential from this plaintext file.
// Replaced by the DPAPI / ECDH-gated vault in Phase 2 — do NOT ship this as-is.
#define FINGERUNLOCK_CONFIG_PATH L"C:\\FingerUnlock\\config.ini"
