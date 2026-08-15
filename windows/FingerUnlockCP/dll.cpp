#include <initguid.h>   // makes DEFINE_GUID in guid.h emit the actual CLSID data here
#include "guid.h"
#include "dll.h"
#include "CFingerUnlockProvider.h"
#include <windows.h>
#include <shlwapi.h>    // QISearch / QITAB
#include <new>

static LONG      g_cRef  = 0;      // outstanding COM objects
HINSTANCE        g_hInst = NULL;

void DllAddRef()  { InterlockedIncrement(&g_cRef); }
void DllRelease() { InterlockedDecrement(&g_cRef); }

// Standard COM class factory that hands out CFingerUnlockProvider instances.
class CClassFactory : public IClassFactory
{
public:
    CClassFactory() : _cRef(1) { DllAddRef(); }

    IFACEMETHODIMP_(ULONG) AddRef()  { return InterlockedIncrement(&_cRef); }
    IFACEMETHODIMP_(ULONG) Release() { LONG c = InterlockedDecrement(&_cRef); if (!c) delete this; return c; }
    IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv)
    {
        static const QITAB qit[] = { QITABENT(CClassFactory, IClassFactory), {0} };
        return QISearch(this, qit, riid, ppv);
    }
    IFACEMETHODIMP CreateInstance(IUnknown* pUnkOuter, REFIID riid, void** ppv)
    {
        if (pUnkOuter) return CLASS_E_NOAGGREGATION;
        return CFingerUnlockProvider_CreateInstance(riid, ppv);
    }
    IFACEMETHODIMP LockServer(BOOL bLock) { if (bLock) DllAddRef(); else DllRelease(); return S_OK; }

private:
    ~CClassFactory() { DllRelease(); }
    LONG _cRef;
};

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv)
{
    HRESULT hr = CLASS_E_CLASSNOTAVAILABLE;
    if (rclsid == CLSID_FingerUnlock) {
        CClassFactory* pcf = new(std::nothrow) CClassFactory();
        if (pcf) { hr = pcf->QueryInterface(riid, ppv); pcf->Release(); }
        else     { hr = E_OUTOFMEMORY; }
    }
    return hr;
}

STDAPI DllCanUnloadNow() { return (g_cRef > 0) ? S_FALSE : S_OK; }

BOOL WINAPI DllMain(HINSTANCE hInst, DWORD dwReason, LPVOID)
{
    if (dwReason == DLL_PROCESS_ATTACH) {
        g_hInst = hInst;
        DisableThreadLibraryCalls(hInst);
    }
    return TRUE;
}
