"""REST API routes. NetBox auto-discovers this module and mounts it under
`/api/plugins/facilitymap/`, namespaced `plugins-api:netbox_facilitymap-api:`."""

from netbox.api.routers import NetBoxRouter

from . import views

app_name = 'netbox_facilitymap'

router = NetBoxRouter()
router.register('rooms', views.RoomViewSet)

urlpatterns = router.urls
