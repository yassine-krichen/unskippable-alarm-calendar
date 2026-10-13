package com.yassine.alarmcalendar;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.yassine.alarmcalendar.alarm.AlarmController;
import com.yassine.alarmcalendar.alarm.AlarmEnginePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // A plugin of this app (not an npm package) is not discovered automatically.
        registerPlugin(AlarmEnginePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Opening the app while an alarm rings (the icon, the status bar clock) goes straight to the alarm screen.
        AlarmController.showIfRinging(this);
    }
}
