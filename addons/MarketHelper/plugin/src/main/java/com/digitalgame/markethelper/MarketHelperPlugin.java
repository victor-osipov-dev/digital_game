package com.digitalgame.markethelper;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;

import org.godotengine.godot.Godot;
import org.godotengine.godot.plugin.GodotPlugin;
import org.godotengine.godot.plugin.UsedByGodot;

/**
 * MarketHelper: батарея + проверка Яндекс Маркета + открытие ссылки.
 * Только RuStore/Android-сборка. Никаких разрешений, никакого сбора
 * данных: PackageManager спрашиваем ровно про один пакет, заряд никуда
 * не отправляем, переходы — только из явного нажатия кнопки.
 */
public class MarketHelperPlugin extends GodotPlugin {
    static final String PLUGIN_NAME = "MarketHelper";
    static final String MARKET_PACKAGE = "ru.beru.android";

    public MarketHelperPlugin(Godot g) {
        super(g);
    }

    @Override
    public String getPluginName() {
        return PLUGIN_NAME;
    }

    private Context appContext() {
        Activity activity = getActivity();
        if (activity != null) {
            return activity.getApplicationContext();
        }
        return null;
    }

    /** Заряд 0..100, <0 — неизвестен (тогда настолки). */
    @UsedByGodot
    public int getBatteryPercent() {
        try {
            Context ctx = appContext();
            if (ctx == null) {
                return -1;
            }
            BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
            if (bm == null) {
                return -1;
            }
            int v = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            if (v < 0 || v > 100) {
                return -1;
            }
            return v;
        } catch (Exception e) {
            return -1;
        }
    }

    /** Установлен ли именно Яндекс Маркет (списки приложений не собираем). */
    @UsedByGodot
    public boolean isMarketInstalled() {
        try {
            Context ctx = appContext();
            if (ctx == null) {
                return false;
            }
            PackageManager pm = ctx.getPackageManager();
            if (Build.VERSION.SDK_INT >= 33) {
                pm.getPackageInfo(MARKET_PACKAGE,
                        PackageManager.PackageInfoFlags.of(0));
            } else {
                pm.getPackageInfo(MARKET_PACKAGE, 0);
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Открыть ссылку: сначала явно в приложении Маркета, иначе обычным
     * браузером/выбором. false — ничего не открылось, игра показывает тост.
     */
    @UsedByGodot
    public boolean openMarketLink(final String url) {
        try {
            Activity activity = getActivity();
            if (activity == null || url == null || url.isEmpty()) {
                return false;
            }
            Uri uri = Uri.parse(url);
            // 1) Явно в Яндекс Маркет, если он есть и берёт ссылку.
            try {
                Intent market = new Intent(Intent.ACTION_VIEW, uri);
                market.setPackage(MARKET_PACKAGE);
                market.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (market.resolveActivity(activity.getPackageManager()) != null) {
                    activity.startActivity(market);
                    return true;
                }
            } catch (Exception ignored) {
            }
            // 2) Fallback: обычный браузер/выбор системы.
            try {
                Intent browser = new Intent(Intent.ACTION_VIEW, uri);
                browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(browser);
                return true;
            } catch (Exception ignored) {
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }
}
