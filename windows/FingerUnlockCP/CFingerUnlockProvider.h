#pragma once
#include <credentialprovider.h>
#include <windows.h>
#include "common.h"

class CFingerUnlockCredential;

// The provider: shows one tile AND watches for an external unlock signal
// (a flag file). When the signal appears it drives an automatic logon — this is
// the hook the phone/service will use instead of a manual click.
class CFingerUnlockProvider : public ICredentialProvider
{
public:
    // IUnknown
    IFACEMETHODIMP_(ULONG) AddRef();
    IFACEMETHODIMP_(ULONG) Release();
    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv);

    // ICredentialProvider
    IFACEMETHODIMP SetUsageScenario(CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus, DWORD dwFlags);
    IFACEMETHODIMP SetSerialization(const CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION* pcpcs);
    IFACEMETHODIMP Advise(ICredentialProviderEvents* pcpe, UINT_PTR upAdviseContext);
    IFACEMETHODIMP UnAdvise();
    IFACEMETHODIMP GetFieldDescriptorCount(DWORD* pdwCount);
    IFACEMETHODIMP GetFieldDescriptorAt(DWORD dwIndex, CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR** ppcpfd);
    IFACEMETHODIMP GetCredentialCount(DWORD* pdwCount, DWORD* pdwDefault, BOOL* pbAutoLogonWithDefault);
    IFACEMETHODIMP GetCredentialAt(DWORD dwIndex, ICredentialProviderCredential** ppcpc);

    CFingerUnlockProvider();

private:
    ~CFingerUnlockProvider();
    static DWORD WINAPI _WatcherThreadProc(LPVOID pv);
    void  _WatchLoop();

    LONG                                _cRef;
    CFingerUnlockCredential*            _pCredential;
    CREDENTIAL_PROVIDER_USAGE_SCENARIO  _cpus;

    // Signal watcher plumbing
    ICredentialProviderEvents*          _pcpe;            // LogonUI's event sink
    UINT_PTR                            _upAdviseContext;
    HANDLE                              _hWatcherThread;
    HANDLE                              _hStopEvent;
    volatile LONG                       _bAutoLogon;      // set by watcher, consumed once
};

HRESULT CFingerUnlockProvider_CreateInstance(REFIID riid, void** ppv);
