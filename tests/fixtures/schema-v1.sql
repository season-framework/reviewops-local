-- ReviewOps Local 1.0.1 schema, exported from commit ecb45bd.
CREATE TABLE activities (
          id TEXT PRIMARY KEY, reviewId TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('comment','created','updated','status')), body TEXT NOT NULL DEFAULT '',
          fromStatus TEXT NOT NULL DEFAULT '', toStatus TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );

CREATE TABLE attachments (
          id TEXT PRIMARY KEY, reviewId TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
          activityId TEXT REFERENCES activities(id) ON DELETE CASCADE,
          name TEXT NOT NULL, mimeType TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL DEFAULT 0 CHECK(size >= 0),
          storageName TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );

CREATE TABLE groups (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );

CREATE TABLE project_services (
          projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          serviceId TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE, PRIMARY KEY(projectId, serviceId)
        );

CREATE TABLE projects (
          id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );

CREATE TABLE reviews (
          id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          serviceId TEXT REFERENCES services(id) ON DELETE RESTRICT,
          number INTEGER NOT NULL CHECK(number > 0), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('open','in_progress','in_review','resolved','recheck','closed')),
          priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','critical')),
          category TEXT NOT NULL CHECK(category IN ('bug','ux','feature','content','other')),
          targetPath TEXT NOT NULL DEFAULT '', targetUrl TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(projectId, number)
        );

CREATE TABLE services (
          id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
          name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('ssh','local')),
          host TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 22 CHECK(port BETWEEN 1 AND 65535), username TEXT NOT NULL DEFAULT '',
          authType TEXT NOT NULL DEFAULT 'agent' CHECK(authType IN ('agent','key','password')),
          privateKeyPath TEXT NOT NULL DEFAULT '', rootPath TEXT NOT NULL, viewerUrl TEXT NOT NULL DEFAULT '',
          hostFingerprint TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );

CREATE TABLE settings (key TEXT PRIMARY KEY, valueJson TEXT NOT NULL);

CREATE INDEX activities_review ON activities(reviewId, createdAt);

CREATE INDEX attachments_review ON attachments(reviewId);

CREATE INDEX projects_group ON projects(groupId);

CREATE INDEX reviews_project ON reviews(projectId, updatedAt);

CREATE INDEX reviews_service ON reviews(serviceId);

CREATE INDEX services_group ON services(groupId);

CREATE TRIGGER activity_attachment_insert BEFORE INSERT ON attachments
        WHEN NEW.activityId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activityId AND reviewId=NEW.reviewId)
        BEGIN SELECT RAISE(ABORT, '같은 리뷰의 댓글에만 첨부할 수 있습니다.'); END;

CREATE TRIGGER activity_attachment_update BEFORE UPDATE OF reviewId,activityId ON attachments
        WHEN NEW.activityId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activityId AND reviewId=NEW.reviewId)
        BEGIN SELECT RAISE(ABORT, '같은 리뷰의 댓글에만 첨부할 수 있습니다.'); END;

CREATE TRIGGER project_group_update BEFORE UPDATE OF groupId ON projects
        WHEN EXISTS(SELECT 1 FROM project_services ps JOIN services s ON s.id=ps.serviceId WHERE ps.projectId=NEW.id AND s.groupId != NEW.groupId)
        BEGIN SELECT RAISE(ABORT, '연결된 서비스가 있는 프로젝트의 그룹을 바꿀 수 없습니다.'); END;

CREATE TRIGGER project_service_delete BEFORE DELETE ON project_services
        WHEN EXISTS(SELECT 1 FROM reviews WHERE projectId=OLD.projectId AND serviceId=OLD.serviceId)
        BEGIN SELECT RAISE(ABORT, '리뷰에서 사용하는 서비스 연결은 해제할 수 없습니다.'); END;

CREATE TRIGGER project_service_group_insert BEFORE INSERT ON project_services
        WHEN (SELECT groupId FROM projects WHERE id=NEW.projectId) != (SELECT groupId FROM services WHERE id=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '서비스와 프로젝트는 같은 그룹에 있어야 합니다.'); END;

CREATE TRIGGER project_service_group_update BEFORE UPDATE ON project_services
        WHEN (SELECT groupId FROM projects WHERE id=NEW.projectId) != (SELECT groupId FROM services WHERE id=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '서비스와 프로젝트는 같은 그룹에 있어야 합니다.'); END;

CREATE TRIGGER review_service_insert BEFORE INSERT ON reviews
        WHEN NEW.serviceId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project_services WHERE projectId=NEW.projectId AND serviceId=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '프로젝트에 연결된 서비스만 리뷰에 지정할 수 있습니다.'); END;

CREATE TRIGGER review_service_update BEFORE UPDATE OF projectId,serviceId ON reviews
        WHEN NEW.serviceId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project_services WHERE projectId=NEW.projectId AND serviceId=NEW.serviceId)
        BEGIN SELECT RAISE(ABORT, '프로젝트에 연결된 서비스만 리뷰에 지정할 수 있습니다.'); END;

CREATE TRIGGER service_group_update BEFORE UPDATE OF groupId ON services
        WHEN EXISTS(SELECT 1 FROM project_services ps JOIN projects p ON p.id=ps.projectId WHERE ps.serviceId=NEW.id AND p.groupId != NEW.groupId)
        BEGIN SELECT RAISE(ABORT, '연결된 프로젝트가 있는 서비스의 그룹을 바꿀 수 없습니다.'); END;

PRAGMA user_version=1;
