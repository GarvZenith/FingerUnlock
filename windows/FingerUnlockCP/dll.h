#pragma once
// Global DLL reference counting — keeps the DLL loaded while any COM object lives.
void DllAddRef();
void DllRelease();
