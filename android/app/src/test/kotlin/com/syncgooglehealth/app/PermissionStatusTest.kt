package com.syncgooglehealth.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PermissionStatusTest {
    private val steps = "android.permission.health.READ_STEPS"
    private val sleep = "android.permission.health.READ_SLEEP"
    private val heartRate = "android.permission.health.READ_HEART_RATE"
    private val all = setOf(
        steps,
        sleep,
        heartRate,
        PermissionPolicy.READ_NUTRITION,
        PermissionPolicy.READ_IN_BACKGROUND,
        PermissionPolicy.READ_HISTORY,
    )

    @Test
    fun everyRequestedPermissionHasALabel() {
        val unlabeled = HealthPermissions.all.filter { permissionLabels(setOf(it)) == listOf(it) }
        assertEquals(emptyList<String>(), unlabeled)
    }

    @Test
    fun labelsFollowDisplayOrderRegardlessOfSetOrder() {
        assertEquals(listOf("歩数", "心拍数", "睡眠"), permissionLabels(setOf(sleep, heartRate, steps)))
    }

    @Test
    fun unknownPermissionsAreShownAsIsAtTheEnd() {
        assertEquals(listOf("睡眠", "x.B", "x.a"), permissionLabels(setOf("x.a", sleep, "x.B")))
    }

    @Test
    fun historyIsNotRequestedWhenTheDeviceCannotUseIt() {
        assertEquals(all, requestablePermissions(all, historyAvailable = true))
        assertEquals(all - PermissionPolicy.READ_HISTORY, requestablePermissions(all, historyAvailable = false))
    }

    @Test
    fun missingRequiredPermissionsAreNamed() {
        val status = healthPermissionStatus(all, granted = setOf(steps, PermissionPolicy.READ_NUTRITION), historyAvailable = true)
        assertEquals(listOf("心拍数", "睡眠", "バックグラウンドでの読み取り"), status.missingRequired)
        assertEquals(listOf("履歴（30 日より前の読み取り）"), status.missingOptional)
    }

    @Test
    fun onlyOptionalPermissionsMissing() {
        val status = healthPermissionStatus(all, granted = all - PermissionPolicy.READ_NUTRITION - PermissionPolicy.READ_HISTORY, historyAvailable = true)
        assertTrue(status.missingRequired.isEmpty())
        assertEquals(listOf("栄養", "履歴（30 日より前の読み取り）"), status.missingOptional)
    }

    @Test
    fun nothingMissingWhenAllRequestableAreGranted() {
        val status = healthPermissionStatus(all, granted = all - PermissionPolicy.READ_HISTORY, historyAvailable = false)
        assertEquals(HealthPermissionStatus(emptyList(), emptyList()), status)
    }

    @Test
    fun notificationGrantedWinsOverEverythingElse() {
        assertEquals(NotificationPermissionState.GRANTED, notificationPermissionState(true, requestedBefore = true, shouldShowRationale = false))
    }

    @Test
    fun notificationRequestableBeforeTheFirstRequest() {
        assertEquals(NotificationPermissionState.REQUESTABLE, notificationPermissionState(false, requestedBefore = false, shouldShowRationale = false))
    }

    @Test
    fun notificationRequestableAfterOneDenial() {
        assertEquals(NotificationPermissionState.REQUESTABLE, notificationPermissionState(false, requestedBefore = true, shouldShowRationale = true))
    }

    @Test
    fun notificationBlockedAfterTwoDenials() {
        assertEquals(NotificationPermissionState.BLOCKED, notificationPermissionState(false, requestedBefore = true, shouldShowRationale = false))
    }
}
