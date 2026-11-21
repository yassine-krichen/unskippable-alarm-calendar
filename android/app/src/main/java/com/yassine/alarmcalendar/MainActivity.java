package com.yassine.alarmcalendar;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.yassine.alarmcalendar.alarm.AlarmController;
import com.yassine.alarmcalendar.alarm.AlarmEnginePlugin;
import com.yassine.alarmcalendar.pickers.NativePickersPlugin;
import com.yassine.alarmcalendar.update.AppUpdatePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // A plugin of this app (not an npm package) is not discovered automatically.
        registerPlugin(AlarmEnginePlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(NativePickersPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Opening the app while an alarm rings (the icon, the status bar clock) goes straight to the alarm screen.
        AlarmController.showIfRinging(this);
    }
}
