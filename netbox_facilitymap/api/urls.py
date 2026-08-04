"""REST API routes. NetBox auto-discovers this module and mounts it under
`/api/plugins/facilitymap/`, namespaced `plugins-api:netbox_facilitymap-api:`.

`rooms/` is the router-registered model viewset. `manifest/` and `placements/` are plain paths:
they are read-only facility *documents*, not model collections, so a router (with its list/detail/
bulk shape) would misdescribe them (API-1)."""

from django.urls import path

from netbox.api.routers import NetBoxRouter

from . import views

app_name = 'netbox_facilitymap'

router = NetBoxRouter()
router.register('rooms', views.RoomViewSet)

urlpatterns = router.urls + [
    path('manifest/', views.ManifestView.as_view(), name='manifest'),
    path('placements/', views.PlacementsView.as_view(), name='placements'),
]
