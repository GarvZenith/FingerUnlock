#include "CFingerUnlockCredential.h"
#include "helpers.h"
#include "guid.h"
#include "dll.h"
#include <shlwapi.h>    // SHStrDupW, QISearch
#include <ntsecapi.h>

CFingerUnlockCredential::CFingerUnlockCredential()
    : _cRef(1), _cpus(CPUS_INVALID), _pCredProvCredentialEvents(NULL)
{
    DllAddRef();
    ZeroMemory(_rgFieldDescriptors, sizeof(_rgFieldDescriptors));
    ZeroMemory(_rgFieldStatePairs,  sizeof(_rgFieldStatePairs));
}

CFingerUnlockCredential::~CFingerUnlockCredential()
{
    for (int i = 0; i < FUFI_NUM_FIELDS; i++)
        CoTaskMemFree(_rgFieldDescriptors[i].pszLabel);
    DllRelease();
}

HRESULT CFingerUnlockCredential::Initialize(CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus,
                                            const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR* rgcpfd,
                                            const FIELD_STATE_PAIR* rgfsp)
{
    _cpus = cpus;
    HRESULT hr = S_OK;
    for (int i = 0; i < FUFI_NUM_FIELDS && SUCCEEDED(hr); i++) {
        _rgFieldStatePairs[i]              = rgfsp[i];
        _rgFieldDescriptors[i].dwFieldID   = rgcpfd[i].dwFieldID;
        _rgFieldDescriptors[i].cpft        = rgcpfd[i].cpft;
        _rgFieldDescriptors[i].guidFieldType = rgcpfd[i].guidFieldType;
        if (rgcpfd[i].pszLabel)
            hr = SHStrDupW(rgcpfd[i].pszLabel, &_rgFieldDescriptors[i].pszLabel);
        else
            _rgFieldDescriptors[i].pszLabel = NULL;
    }
    return hr;
}

// ---- IUnknown ---------------------------------------------------------------
ULONG CFingerUnlockCredential::AddRef()  { return InterlockedIncrement(&_cRef); }
ULONG CFingerUnlockCredential::Release()
{
    LONG cRef = InterlockedDecrement(&_cRef);
    if (!cRef) delete this;
    return cRef;
}
HRESULT CFingerUnlockCredential::QueryInterface(REFIID riid, void** ppv)
{
    static const QITAB qit[] = { QITABENT(CFingerUnlockCredential, ICredentialProviderCredential), {0} };
    return QISearch(this, qit, riid, ppv);
}

// ---- Boilerplate UI plumbing ------------------------------------------------
HRESULT CFingerUnlockCredential::Advise(ICredentialProviderCredentialEvents* pcpce)
{
    if (_pCredProvCredentialEvents) _pCredProvCredentialEvents->Release();
    _pCredProvCredentialEvents = pcpce;
    if (pcpce) pcpce->AddRef();
    return S_OK;
}
HRESULT CFingerUnlockCredential::UnAdvise()
{
    if (_pCredProvCredentialEvents) _pCredProvCredentialEvents->Release();
    _pCredProvCredentialEvents = NULL;
    return S_OK;
}
HRESULT CFingerUnlockCredential::SetSelected(BOOL* pbAutoLogon) { *pbAutoLogon = FALSE; return S_OK; }
HRESULT CFingerUnlockCredential::SetDeselected() { return S_OK; }

HRESULT CFingerUnlockCredential::GetFieldState(DWORD dwFieldID,
                                               CREDENTIAL_PROVIDER_FIELD_STATE* pcpfs,
                                               CREDENTIAL_PROVIDER_FIELD_INTERACTIVE_STATE* pcpfis)
{
    if (dwFieldID < FUFI_NUM_FIELDS && pcpfs && pcpfis) {
        *pcpfs  = _rgFieldStatePairs[dwFieldID].cpfs;
        *pcpfis = _rgFieldStatePairs[dwFieldID].cpfis;
        return S_OK;
    }
    return E_INVALIDARG;
}

HRESULT CFingerUnlockCredential::GetStringValue(DWORD dwFieldID, PWSTR* ppwsz)
{
    if (dwFieldID < FUFI_NUM_FIELDS && ppwsz) {
        PCWSTR psz = _rgFieldDescriptors[dwFieldID].pszLabel ? _rgFieldDescriptors[dwFieldID].pszLabel : L"";
        return SHStrDupW(psz, ppwsz);
    }
    return E_INVALIDARG;
}

HRESULT CFingerUnlockCredential::GetBitmapValue(DWORD, HBITMAP*)              { return E_NOTIMPL; }
HRESULT CFingerUnlockCredential::GetCheckboxValue(DWORD, BOOL*, PWSTR*)      { return E_NOTIMPL; }

HRESULT CFingerUnlockCredential::GetSubmitButtonValue(DWORD dwFieldID, DWORD* pdwAdjacentTo)
{
    if (dwFieldID == FUFI_SUBMIT_BUTTON && pdwAdjacentTo) { *pdwAdjacentTo = FUFI_LABEL; return S_OK; }
    return E_INVALIDARG;
}

HRESULT CFingerUnlockCredential::GetComboBoxValueCount(DWORD, DWORD*, DWORD*) { return E_NOTIMPL; }
HRESULT CFingerUnlockCredential::GetComboBoxValueAt(DWORD, DWORD, PWSTR*)     { return E_NOTIMPL; }
HRESULT CFingerUnlockCredential::SetStringValue(DWORD, PCWSTR)               { return E_NOTIMPL; }
HRESULT CFingerUnlockCredential::SetCheckboxValue(DWORD, BOOL)              { return E_NOTIMPL; }
HRESULT CFingerUnlockCredential::SetComboBoxSelectedValue(DWORD, DWORD)     { return E_NOTIMPL; }
HRESULT CFingerUnlockCredential::CommandLinkClicked(DWORD)                  { return E_NOTIMPL; }

// ---- The actual unlock ------------------------------------------------------
// Called when the tile is submitted. We read the stored credential, pack it the
// way LSA wants, and return CPGSR_RETURN_CREDENTIAL_FINISHED so LogonUI submits
// it. Phase 1 reads plaintext from config.ini; Phase 2 swaps in the ECDH vault.
HRESULT CFingerUnlockCredential::GetSerialization(
    CREDENTIAL_PROVIDER_GET_SERIALIZATION_RESPONSE* pcpgsr,
    CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION* pcpcs,
    PWSTR* ppwszOptionalStatusText,
    CREDENTIAL_PROVIDER_STATUS_ICON* pcpsiOptionalStatusIcon)
{
    *ppwszOptionalStatusText  = NULL;
    *pcpsiOptionalStatusIcon  = CPSI_NONE;

    WCHAR wzUser[256]   = {0};
    WCHAR wzPass[256]   = {0};
    WCHAR wzDomain[256] = {0};
    GetPrivateProfileStringW(L"credentials", L"username", L"", wzUser,   ARRAYSIZE(wzUser),   FINGERUNLOCK_CONFIG_PATH);
    GetPrivateProfileStringW(L"credentials", L"password", L"", wzPass,   ARRAYSIZE(wzPass),   FINGERUNLOCK_CONFIG_PATH);
    GetPrivateProfileStringW(L"credentials", L"domain",   L".", wzDomain, ARRAYSIZE(wzDomain), FINGERUNLOCK_CONFIG_PATH);

    // "." (or blank) means "this machine" -> use the local computer name.
    if (wzDomain[0] == L'\0' || (wzDomain[0] == L'.' && wzDomain[1] == L'\0')) {
        DWORD cch = ARRAYSIZE(wzDomain);
        GetComputerNameW(wzDomain, &cch);
    }

    if (wzUser[0] == L'\0') {
        SHStrDupW(L"FingerUnlock: config.ini missing username.", ppwszOptionalStatusText);
        *pcpsiOptionalStatusIcon = CPSI_ERROR;
        return S_FALSE;   // keep the tile up, show the message
    }

    KERB_INTERACTIVE_UNLOCK_LOGON kiul;
    HRESULT hr = KerbInteractiveUnlockLogonInit(wzDomain, wzUser, wzPass, _cpus, &kiul);
    if (SUCCEEDED(hr)) {
        BYTE* rgb = NULL; DWORD cb = 0;
        hr = KerbInteractiveUnlockLogonPack(kiul, &rgb, &cb);
        if (SUCCEEDED(hr)) {
            ULONG ulAuthPackage;
            hr = RetrieveNegotiateAuthPackage(&ulAuthPackage);
            if (SUCCEEDED(hr)) {
                pcpcs->ulAuthenticationPackage = ulAuthPackage;
                pcpcs->clsidCredentialProvider = CLSID_FingerUnlock;
                pcpcs->rgbSerialization        = rgb;
                pcpcs->cbSerialization         = cb;
                *pcpgsr = CPGSR_RETURN_CREDENTIAL_FINISHED;
            } else {
                CoTaskMemFree(rgb);
            }
        }
    }

    SecureZeroMemory(wzPass, sizeof(wzPass));   // don't leave the password in memory
    return hr;
}

HRESULT CFingerUnlockCredential::ReportResult(NTSTATUS, NTSTATUS,
                                              PWSTR* ppwszOptionalStatusText,
                                              CREDENTIAL_PROVIDER_STATUS_ICON* pcpsi)
{
    *ppwszOptionalStatusText = NULL;
    *pcpsi = CPSI_NONE;
    return S_OK;
}
