#define SECURITY_WIN32
#include "helpers.h"
#include <security.h>   // NEGOSSP_NAME_A
#include <shlwapi.h>    // SHStrDupW

#ifndef STATUS_SUCCESS
#define STATUS_SUCCESS ((NTSTATUS)0x00000000L)
#endif

// ---- The tile's fields ------------------------------------------------------
// A large label plus a submit button. No text boxes: the password comes from
// the stored vault, not from the user typing at the lock screen.
const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR s_rgCredProvFieldDescriptors[FUFI_NUM_FIELDS] = {
    { FUFI_LABEL,         CPFT_LARGE_TEXT,    (LPWSTR)L"FingerUnlock" },
    { FUFI_SUBMIT_BUTTON, CPFT_SUBMIT_BUTTON, (LPWSTR)L"Unlock" },
};

const FIELD_STATE_PAIR s_rgFieldStatePairs[FUFI_NUM_FIELDS] = {
    { CPFS_DISPLAY_IN_BOTH,          CPFIS_NONE },   // label
    { CPFS_DISPLAY_IN_SELECTED_TILE, CPFIS_NONE },   // submit button
};

HRESULT FieldDescriptorCoAllocCopy(const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR& rcpfd,
                                   CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR** ppcpfd)
{
    HRESULT hr;
    CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR* pcpfd =
        (CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR*)CoTaskMemAlloc(sizeof(*pcpfd));
    if (pcpfd) {
        pcpfd->dwFieldID     = rcpfd.dwFieldID;
        pcpfd->cpft          = rcpfd.cpft;
        pcpfd->guidFieldType = rcpfd.guidFieldType;
        if (rcpfd.pszLabel) {
            hr = SHStrDupW(rcpfd.pszLabel, &pcpfd->pszLabel);
        } else {
            pcpfd->pszLabel = NULL;
            hr = S_OK;
        }
        if (FAILED(hr)) { CoTaskMemFree(pcpfd); pcpfd = NULL; }
    } else {
        hr = E_OUTOFMEMORY;
    }
    *ppcpfd = pcpfd;
    return hr;
}

// ---- KERB unlock logon packing ---------------------------------------------
static void UnicodeStringInitWithString(PWSTR pwz, UNICODE_STRING* pus)
{
    if (pwz) {
        size_t len = wcslen(pwz);
        pus->Length        = (USHORT)(len * sizeof(WCHAR));
        pus->MaximumLength = (USHORT)((len + 1) * sizeof(WCHAR));
        pus->Buffer        = pwz;
    } else {
        pus->Length = 0; pus->MaximumLength = 0; pus->Buffer = NULL;
    }
}

HRESULT KerbInteractiveUnlockLogonInit(PWSTR pwzDomain, PWSTR pwzUsername, PWSTR pwzPassword,
                                       CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus,
                                       KERB_INTERACTIVE_UNLOCK_LOGON* pkiul)
{
    KERB_INTERACTIVE_UNLOCK_LOGON kiul;
    ZeroMemory(&kiul, sizeof(kiul));
    KERB_INTERACTIVE_LOGON* pkil = &kiul.Logon;
    UnicodeStringInitWithString(pwzDomain,   &pkil->LogonDomainName);
    UnicodeStringInitWithString(pwzUsername, &pkil->UserName);
    UnicodeStringInitWithString(pwzPassword, &pkil->Password);
    switch (cpus) {
        case CPUS_UNLOCK_WORKSTATION: pkil->MessageType = KerbWorkstationUnlockLogon; break;
        case CPUS_LOGON:              pkil->MessageType = KerbInteractiveLogon;        break;
        default:                      return E_FAIL;
    }
    *pkiul = kiul;
    return S_OK;
}

// Copies a string into the packed blob and rewrites Buffer as a byte offset
// from the start of the blob — the form LSA expects for a serialized logon.
static void PackedCopy(const UNICODE_STRING& src, BYTE* base, BYTE** ppb, UNICODE_STRING* dst)
{
    dst->Length        = src.Length;
    dst->MaximumLength = src.Length;
    if (src.Length) CopyMemory(*ppb, src.Buffer, src.Length);
    dst->Buffer = (PWSTR)(*ppb - base);   // relative offset, not a real pointer
    *ppb += src.Length;
}

HRESULT KerbInteractiveUnlockLogonPack(const KERB_INTERACTIVE_UNLOCK_LOGON& rkiulIn,
                                       BYTE** prgb, DWORD* pcb)
{
    const KERB_INTERACTIVE_LOGON* pkilIn = &rkiulIn.Logon;
    DWORD cb = sizeof(rkiulIn)
             + pkilIn->LogonDomainName.Length
             + pkilIn->UserName.Length
             + pkilIn->Password.Length;

    KERB_INTERACTIVE_UNLOCK_LOGON* pOut = (KERB_INTERACTIVE_UNLOCK_LOGON*)CoTaskMemAlloc(cb);
    if (!pOut) return E_OUTOFMEMORY;

    ZeroMemory(&pOut->LogonId, sizeof(pOut->LogonId));
    BYTE* base = (BYTE*)pOut;
    BYTE* pb   = base + sizeof(*pOut);
    KERB_INTERACTIVE_LOGON* pkilOut = &pOut->Logon;
    pkilOut->MessageType = pkilIn->MessageType;
    PackedCopy(pkilIn->LogonDomainName, base, &pb, &pkilOut->LogonDomainName);
    PackedCopy(pkilIn->UserName,        base, &pb, &pkilOut->UserName);
    PackedCopy(pkilIn->Password,        base, &pb, &pkilOut->Password);

    *prgb = (BYTE*)pOut;
    *pcb  = cb;
    return S_OK;
}

HRESULT RetrieveNegotiateAuthPackage(ULONG* pulAuthPackage)
{
    HANDLE hLsa;
    NTSTATUS status = LsaConnectUntrusted(&hLsa);
    if (status != STATUS_SUCCESS) return HRESULT_FROM_NT(status);

    HRESULT hr;
    ULONG ulAuthPackage;
    LSA_STRING name;
    char szNego[] = NEGOSSP_NAME_A;
    name.Buffer        = szNego;
    name.Length        = (USHORT)strlen(szNego);
    name.MaximumLength = name.Length + 1;

    status = LsaLookupAuthenticationPackage(hLsa, &name, &ulAuthPackage);
    if (status == STATUS_SUCCESS) { *pulAuthPackage = ulAuthPackage; hr = S_OK; }
    else                          { hr = HRESULT_FROM_NT(status); }

    LsaDeregisterLogonProcess(hLsa);
    return hr;
}
