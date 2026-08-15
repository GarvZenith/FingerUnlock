#pragma once
#include <windows.h>
#include <credentialprovider.h>
#include <ntsecapi.h>
#include "common.h"

// The static field table + their initial states (defined in helpers.cpp).
extern const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR s_rgCredProvFieldDescriptors[FUFI_NUM_FIELDS];
extern const FIELD_STATE_PAIR                      s_rgFieldStatePairs[FUFI_NUM_FIELDS];

// Deep-copies a field descriptor into CoTaskMem (LogonUI frees it).
HRESULT FieldDescriptorCoAllocCopy(const CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR& rcpfd,
                                   CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR** ppcpfd);

// Build + pack a KERB_INTERACTIVE_UNLOCK_LOGON that LSA understands.
HRESULT KerbInteractiveUnlockLogonInit(PWSTR pwzDomain, PWSTR pwzUsername, PWSTR pwzPassword,
                                       CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus,
                                       KERB_INTERACTIVE_UNLOCK_LOGON* pkiul);
HRESULT KerbInteractiveUnlockLogonPack(const KERB_INTERACTIVE_UNLOCK_LOGON& rkiulIn,
                                       BYTE** prgb, DWORD* pcb);

// Ask LSA for the Negotiate auth package id used to submit the credential.
HRESULT RetrieveNegotiateAuthPackage(ULONG* pulAuthPackage);
