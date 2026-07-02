package com.google.inject;

/**
 * SHIM: minimal stand-in for Guice's Injector — only the surface the carved
 * kernel calls through Application.getInjector(). Real Guice never runs in
 * the web engine.
 */
public interface Injector {
    <T> T getInstance(Class<T> type);
}
