#include "CFingerUnlockProvider.h"
#include "CFingerUnlockCredential.h"
#include "helpers.h"
#include "dll.h"
#include <shlwapi.h>   // QISearch / QITAB
#include <new>

// The external unlock signal. Anything that can create this file (our test
// script now; the LocalSystem service driven by the phone later) triggers an
// automatic unlock.
#define FINGERUNLOCK_FLAG_PATH L"C:\\FingerUnlock\\unlock.flag"

CFingerUnlockProvider::CFingerUnlockProvider()
    : _cRef(1), _pCredential(NULL), _cpus(CPUS_INVALID),
      _pcpe(NULL), _upAdviseContext(0),
      _hWatcherThread(NULL), _hStopEvent(NULL), _bAutoLogon(0)
{
    DllAddRef();
}

CFingerUnlockProvider::~CFingerUnlockProvider()
{
    UnAdvise();   // make sure the watcher thread is stopped
    if (_pCredential) { _pCredential->Release(); _pCredential = NULL; }
    DllRelease();
}

ULONG CFingerUnlockProvider::AddRef()  { return InterlockedIncrement(&_cRef); }
ULONG CFingerUnlockProvider::Release()
{
    LONG cRef = InterlockedDecrement(&_cRef);
    if (!cRef) delete this;
    return cRef;
}

HRESULT CFingerUnlockProvider::QueryInterface(REFIID riid, void** ppv)
{
    static const QITAB qit[] = { QITABENT(CFingerUnlockProvider, ICredentialProvider), {0} };
    return QISearch(this, qit, riid, ppv);
}

HRESULT CFingerUnlockProvider::SetUsageScenario(CREDENTIAL_PROVIDER_USAGE_SCENARIO cpus, DWORD)
{
    HRESULT hr;
    switch (cpus) {
    case CPUS_LOGON:
    case CPUS_UNLOCK_WORKSTATION:
        _cpus = cpus;
        if (!_pCredential) {
            _pCredential = new(std::nothrow) CFingerUnlockCredential();
            if (_pCredential) {
                hr = _pCredential->Initialize(_cpus, s_rgCredProvFieldDescriptors, s_rgFieldStatePairs);
                if (FAILED(hr)) { _pCredential->Release(); _pCredential = NULL; }
            } else {
                hr = E_OUTOFMEMORY;
            }
        } else {
            hr = S_OK;
        }
        break;
    case CPUS_CHANGE_PASSWORD:
    case CPUS_CREDUI:
        hr = E_NOTIMPL;
        break;
    default:
        hr = E_INVALIDARG;
        break;
    }
    return hr;
}

HRESULT CFingerUnlockProvider::SetSerialization(const CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION*)
{
    return E_NOTIMPL;
}

// LogonUI advises us with its event sink when our tiles are on screen. That's
// when we start watching for the signal; UnAdvise stops it.
HRESULT CFingerUnlockProvider::Advise(ICredentialProviderEvents* pcpe, UINT_PTR upAdviseContext)
{
    if (_pcpe) _pcpe->Release();
    _pcpe = pcpe;
    if (_pcpe) _pcpe->AddRef();
    _upAdviseContext = upAdviseContext;

    if (!_hWatcherThread) {
        _hStopEvent = CreateEvent(NULL, TRUE, FALSE, NULL);   // manual-reset
        _hWatcherThread = CreateThread(NULL, 0, _WatcherThreadProc, this, 0, NULL);
    }
    return S_OK;
}

HRESULT CFingerUnlockProvider::UnAdvise()
{
    if (_hWatcherThread) {
        SetEvent(_hStopEvent);
        WaitForSingleObject(_hWatcherThread, INFINITE);
        CloseHandle(_hWatcherThread);
        _hWatcherThread = NULL;
    }
    if (_hStopEvent) { CloseHandle(_hStopEvent); _hStopEvent = NULL; }
    if (_pcpe) { _pcpe->Release(); _pcpe = NULL; }
    _upAdviseContext = 0;
    return S_OK;
}

DWORD WINAPI CFingerUnlockProvider::_WatcherThreadProc(LPVOID pv)
{
    reinterpret_cast<CFingerUnlockProvider*>(pv)->_WatchLoop();
    return 0;
}

// Poll for the flag file ~ every 400 ms. On seeing it: delete it (one signal =
// one unlock), mark auto-logon, and tell LogonUI to re-read our credentials.
void CFingerUnlockProvider::_WatchLoop()
{
    for (;;) {
        if (WaitForSingleObject(_hStopEvent, 400) == WAIT_OBJECT_0)
            break;   // stop requested

        if (GetFileAttributesW(FINGERUNLOCK_FLAG_PATH) != INVALID_FILE_ATTRIBUTES) {
            DeleteFileW(FINGERUNLOCK_FLAG_PATH);
            InterlockedExchange(&_bAutoLogon, 1);
            if (_pcpe)
                _pcpe->CredentialsChanged(_upAdviseContext);
        }
    }
}

HRESULT CFingerUnlockProvider::GetFieldDescriptorCount(DWORD* pdwCount)
{
    *pdwCount = FUFI_NUM_FIELDS;
    return S_OK;
}

HRESULT CFingerUnlockProvider::GetFieldDescriptorAt(DWORD dwIndex, CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR** ppcpfd)
{
    if (dwIndex < FUFI_NUM_FIELDS && ppcpfd)
        return FieldDescriptorCoAllocCopy(s_rgCredProvFieldDescriptors[dwIndex], ppcpfd);
    return E_INVALIDARG;
}

// If the watcher fired, ask LogonUI to auto-submit the default tile (consume the
// flag so a failed attempt doesn't loop forever).
HRESULT CFingerUnlockProvider::GetCredentialCount(DWORD* pdwCount, DWORD* pdwDefault, BOOL* pbAutoLogonWithDefault)
{
    *pdwCount = 1;
    *pdwDefault = 0;
    *pbAutoLogonWithDefault = (InterlockedExchange(&_bAutoLogon, 0) != 0) ? TRUE : FALSE;
    return S_OK;
}

HRESULT CFingerUnlockProvider::GetCredentialAt(DWORD dwIndex, ICredentialProviderCredential** ppcpc)
{
    HRESULT hr = E_INVALIDARG;
    if (dwIndex == 0 && ppcpc && _pCredential)
        hr = _pCredential->QueryInterface(IID_PPV_ARGS(ppcpc));
    return hr;
}

HRESULT CFingerUnlockProvider_CreateInstance(REFIID riid, void** ppv)
{
    HRESULT hr;
    CFingerUnlockProvider* p = new(std::nothrow) CFingerUnlockProvider();
    if (p) { hr = p->QueryInterface(riid, ppv); p->Release(); }
    else   { hr = E_OUTOFMEMORY; }
    return hr;
}
